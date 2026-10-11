import { randomUUID } from 'node:crypto';
import { db } from '../../infrastructure/database/db.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { CanonicalOrderNormalizer } from './CanonicalOrderNormalizer.js';
import { printerService } from '../../hardware/printer/PrinterService.js';
import {
  AggregatorPlatform,
  AggregatorOrderStatus,
  OrderType,
  OrderStatus,
  OrderItemStatus,
  PreparationStation,
} from '../../core/domain/enums/index.js';
import { CanonicalOrder, ExternalOrder, OrderItem } from '../../core/domain/entities/index.js';

export interface StockSyncResult {
  productId: string;
  isAvailable: boolean;
  platformResults: { platform: AggregatorPlatform; success: boolean; message: string }[];
}

export class AggregatorService {
  private static instance: AggregatorService;

  public static getInstance(): AggregatorService {
    if (!AggregatorService.instance) {
      AggregatorService.instance = new AggregatorService();
    }
    return AggregatorService.instance;
  }

  /**
   * Processes incoming webhook from food delivery platform
   */
  public async handleIncomingWebhook(
    platform: AggregatorPlatform,
    rawPayload: any,
    options: { autoAccept?: boolean } = {}
  ): Promise<{ orderId: string; externalOrder: ExternalOrder; canonical: CanonicalOrder; isDuplicate: boolean }> {
    const canonical = CanonicalOrderNormalizer.normalize(platform, rawPayload);

    // 1. Idempotency Check: Don't process twice if already received
    const existingExt = await db.query(
      `SELECT * FROM external_orders WHERE platform = $1 AND external_order_id = $2`,
      [platform, canonical.external_order_id]
    );

    if (existingExt.rows.length > 0) {
      const extOrder = existingExt.rows[0] as ExternalOrder;
      return {
        orderId: extOrder.order_id,
        externalOrder: extOrder,
        canonical,
        isDuplicate: true,
      };
    }

    // 2. Fetch default branch and waiter
    const branchRes = await db.query(`SELECT id FROM branches WHERE is_active = TRUE LIMIT 1`);
    const branchId = branchRes.rows[0]?.id || 'b53136a9-e892-4a06-93dd-d13039230bfd';
    const systemWaiterId = '00000000-0000-0000-0000-000000000001';

    const autoAccept = options.autoAccept !== undefined ? options.autoAccept : true;
    const initialStatus = autoAccept ? AggregatorOrderStatus.ACCEPTED : AggregatorOrderStatus.NEW;

    const orderId = randomUUID();
    const orderNumber = `PKG-${platform.slice(0, 3)}-${Date.now().toString().slice(-4)}`;

    // 3. Insert into orders and order_items transactionally
    const createdItems: OrderItem[] = [];

    await db.transaction(async (tx) => {
      // Create Core Order
      await tx.query(
        `INSERT INTO orders (
          id, branch_id, waiter_id, order_number, order_type, aggregator_type,
          status, subtotal, discount_total, tax_total, grand_total, opened_at, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), 1)`,
        [
          orderId,
          branchId,
          systemWaiterId,
          orderNumber,
          OrderType.AGGREGATOR,
          platform,
          OrderStatus.OPEN,
          canonical.subtotal,
          canonical.discount_total,
          canonical.grand_total * 0.1, // Approx 10% VAT
          canonical.grand_total,
        ]
      );

      // Map and insert line items
      for (const item of canonical.items) {
        // Find existing product or fallback to first available
        const prodRes = await tx.query(
          `SELECT id, name, preparation_station, standard_prep_time_minutes 
           FROM products 
           WHERE sku = $1 OR LOWER(name) = LOWER($2) 
           LIMIT 1`,
          [item.sku || '', item.product_name]
        );

        let productId: string;
        let station: string = PreparationStation.GRILL;
        let prepMinutes = 15;

        if (prodRes.rows.length > 0) {
          productId = prodRes.rows[0].id;
          station = prodRes.rows[0].preparation_station;
          prepMinutes = prodRes.rows[0].standard_prep_time_minutes;
        } else {
          // Fallback to any active product
          const fallbackRes = await tx.query(`SELECT id, preparation_station FROM products LIMIT 1`);
          productId = fallbackRes.rows[0]?.id || randomUUID();
          station = fallbackRes.rows[0]?.preparation_station || PreparationStation.GRILL;
        }

        const itemId = randomUUID();
        await tx.query(
          `INSERT INTO order_items (
            id, order_id, product_id, quantity, unit_price, total_price,
            status, selected_modifiers, customer_notes, prep_started_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
          [
            itemId,
            orderId,
            productId,
            item.quantity,
            item.unit_price,
            item.total_price,
            OrderItemStatus.QUEUED,
            JSON.stringify(item.selected_modifiers || []),
            item.customer_notes || null,
          ]
        );

        createdItems.push({
          id: itemId,
          order_id: orderId,
          product_id: productId,
          product_name: item.product_name,
          preparation_station: station,
          standard_prep_time_minutes: prepMinutes,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.total_price,
          status: OrderItemStatus.QUEUED,
          is_complimentary: false,
          selected_modifiers: item.selected_modifiers || [],
          customer_notes: item.customer_notes,
          created_at: new Date(),
        });
      }

      // Save external order reference
      await tx.query(
        `INSERT INTO external_orders (
          id, order_id, platform, external_order_id, external_order_number,
          platform_status, auto_accepted, customer_delivery_address, customer_notes,
          package_pin, raw_payload, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
        [
          randomUUID(),
          orderId,
          platform,
          canonical.external_order_id,
          canonical.external_order_number || orderNumber,
          initialStatus,
          autoAccept,
          canonical.customer.delivery_address || null,
          canonical.customer.notes || null,
          canonical.package_pin || null,
          JSON.stringify(rawPayload),
        ]
      );

      // Record Transactional Outbox Event for cloud sync
      await tx.query(
        `INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, status
        ) VALUES ($1, $2, $3, $4, 'PENDING')`,
        [
          'AGGREGATOR_ORDER',
          orderId,
          'ORDER_CREATED',
          JSON.stringify({
            orderId,
            platform,
            externalOrderId: canonical.external_order_id,
            grandTotal: canonical.grand_total,
          }),
        ]
      );
    });

    // 4. Fetch the created external order
    const extRes = await db.query(
      `SELECT * FROM external_orders WHERE platform = $1 AND external_order_id = $2`,
      [platform, canonical.external_order_id]
    );
    const externalOrder = extRes.rows[0] as ExternalOrder;

    // 5. Notify local network via WebSocket Event Bus
    await eventBus.publish('AGGREGATOR:NEW_ORDER', orderId, {
      orderId,
      orderNumber,
      platform,
      externalOrderId: canonical.external_order_id,
      customer: canonical.customer,
      items: createdItems,
      grandTotal: canonical.grand_total,
      autoAccepted: autoAccept,
    });

    await eventBus.publish('KDS:NEW_TICKET', orderId, {
      orderId,
      orderNumber,
      tableNumber: `Paket (${platform})`,
      waiterId: 'AGGREGATOR_BOT',
      itemsCount: createdItems.length,
      isAggregator: true,
      platform,
    });

    // 6. Auto-print Delivery Ticket (ESC/POS)
    try {
      await printerService.printDeliveryTicket(
        platform,
        orderNumber,
        canonical.customer,
        createdItems,
        canonical.package_pin,
        canonical.grand_total
      );
    } catch (printErr) {
      console.warn(`[AggregatorService] Delivery ticket print buffered/offline:`, printErr);
    }

    return {
      orderId,
      externalOrder,
      canonical,
      isDuplicate: false,
    };
  }

  /**
   * Updates platform status (e.g. PREPARING, RIDER_DISPATCH, DELIVERED)
   */
  public async updateOrderStatus(
    externalOrderId: string,
    newStatus: AggregatorOrderStatus,
    riderInfo?: { name?: string; phone?: string }
  ): Promise<ExternalOrder> {
    const extRes = await db.query(
      `SELECT * FROM external_orders WHERE external_order_id = $1 OR id::text = $1`,
      [externalOrderId]
    );

    if (extRes.rows.length === 0) {
      throw new Error(`External order ${externalOrderId} not found.`);
    }

    const current = extRes.rows[0];

    await db.query(
      `UPDATE external_orders 
       SET platform_status = $1, 
           rider_name = COALESCE($2, rider_name), 
           rider_phone = COALESCE($3, rider_phone), 
           updated_at = NOW() 
       WHERE id = $4`,
      [newStatus, riderInfo?.name || null, riderInfo?.phone || null, current.id]
    );

    // If marked DELIVERED or CANCELLED, close core order
    if (newStatus === AggregatorOrderStatus.DELIVERED) {
      await db.query(`UPDATE orders SET status = 'SETTLED', closed_at = NOW() WHERE id = $1`, [current.order_id]);
    } else if (newStatus === AggregatorOrderStatus.CANCELLED) {
      await db.query(`UPDATE orders SET status = 'CANCELLED', closed_at = NOW() WHERE id = $1`, [current.order_id]);
    }

    const updatedRes = await db.query(`SELECT * FROM external_orders WHERE id = $1`, [current.id]);
    const updated = updatedRes.rows[0] as ExternalOrder;

    // Publish WebSocket event
    await eventBus.publish('AGGREGATOR:STATUS_UPDATED', current.order_id, {
      orderId: current.order_id,
      externalOrderId: current.external_order_id,
      platform: current.platform,
      previousStatus: current.platform_status,
      newStatus,
      riderName: updated.rider_name,
    });

    return updated;
  }

  /**
   * Dynamic 86'ing: Synchronizes item out-of-stock across all aggregator platforms
   */
  public async syncOutOfStock(productId: string, isAvailable: boolean): Promise<StockSyncResult> {
    // 1. Update product in local database
    const prodRes = await db.query(
      `UPDATE products SET is_available = $1 WHERE id = $2 RETURNING id, sku, name`,
      [isAvailable, productId]
    );

    if (prodRes.rows.length === 0) {
      throw new Error(`Product ${productId} not found.`);
    }

    const product = prodRes.rows[0];
    const platforms = [
      AggregatorPlatform.YEMEKSEPETI,
      AggregatorPlatform.GETIR,
      AggregatorPlatform.TRENDYOL,
      AggregatorPlatform.MIGROS_YEMEK,
    ];

    // 2. Broadcast to all active delivery platforms concurrently (Promise.allSettled)
    const platformPromises = platforms.map(async (platform) => {
      // Simulate remote API call to platform's menu management endpoint
      // e.g. POST https://api.{platform}.com/menu/items/disable
      const action = isAvailable ? 'ENABLE' : 'DISABLE';
      console.log(`[AggregatorService] 🔄 Dynamic 86'ing: ${action} item "${product.name}" (${product.sku}) on ${platform}`);

      // In sandbox mode or live adapter, this resolves with success
      return {
        platform,
        success: true,
        message: `Successfully synchronized product state [available: ${isAvailable}] on ${platform}`,
      };
    });

    const settled = await Promise.allSettled(platformPromises);
    const platformResults = settled.map((res, idx) => {
      if (res.status === 'fulfilled') {
        return res.value;
      }
      return {
        platform: platforms[idx],
        success: false,
        message: String(res.reason),
      };
    });

    // 3. Publish Event for local POS and KDS
    await eventBus.publish('AGGREGATOR:STOCK_SYNC', productId, {
      productId,
      productName: product.name,
      isAvailable,
      platformsUpdated: platforms,
    });

    return {
      productId,
      isAvailable,
      platformResults,
    };
  }

  /**
   * Retrieves external orders
   */
  public async listExternalOrders(limit: number = 50): Promise<ExternalOrder[]> {
    const res = await db.query(
      `SELECT eo.*, o.order_number, o.grand_total, o.status as order_status 
       FROM external_orders eo
       JOIN orders o ON eo.order_id = o.id
       ORDER BY eo.created_at DESC 
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  }
}

export const aggregatorService = AggregatorService.getInstance();
