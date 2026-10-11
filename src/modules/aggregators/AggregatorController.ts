import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { aggregatorService } from './AggregatorService.js';
import { AggregatorPlatform, AggregatorOrderStatus } from '../../core/domain/enums/index.js';

export async function aggregatorRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Platform Webhook Receiver (Yemeksepeti, Getir, Trendyol, Migros)
   */
  fastify.post('/webhooks/:platform', async (request: FastifyRequest, reply: FastifyReply) => {
    const { platform } = request.params as { platform: string };
    const upperPlatform = platform.toUpperCase() as AggregatorPlatform;

    if (!Object.values(AggregatorPlatform).includes(upperPlatform)) {
      return reply.code(400).send({
        success: false,
        message: `Unsupported aggregator platform: ${platform}. Supported: ${Object.values(AggregatorPlatform).join(', ')}`,
      });
    }

    const payload = request.body;
    const result = await aggregatorService.handleIncomingWebhook(upperPlatform, payload);

    return reply.code(result.isDuplicate ? 200 : 201).send({
      success: true,
      message: result.isDuplicate ? 'Order already processed (idempotent)' : 'Order successfully received and routed to KDS',
      orderId: result.orderId,
      externalOrder: result.externalOrder,
    });
  });

  /**
   * Sandbox Simulator for developers to easily simulate food delivery orders
   */
  fastify.post('/simulate-order', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as {
      platform?: AggregatorPlatform;
      productName?: string;
      quantity?: number;
      customerName?: string;
      deliveryAddress?: string;
      notes?: string;
    };

    const platform = body.platform || AggregatorPlatform.GETIR;
    const orderId = `SIM-${Date.now()}`;

    // Produce sample payload matching platform's raw format
    let samplePayload: any;

    if (platform === AggregatorPlatform.GETIR) {
      samplePayload = {
        id: orderId,
        confirmationId: `GTR-${orderId.slice(-4)}`,
        client: {
          name: body.customerName || 'Ahmet Yılmaz',
          contactPhoneNumber: '05551234567',
          deliveryAddress: {
            address: body.deliveryAddress || 'Bağdat Cad. No: 42 Kadıköy / İstanbul',
            notes: body.notes || 'Zile basmayın lütfen, bebek uyuyor',
          },
        },
        products: [
          {
            product: {
              id: 'GRL-01',
              name: body.productName || 'Antrikot Izgara',
              price: 550.0,
            },
            count: body.quantity || 1,
            price: 550.0,
            options: [{ name: 'Orta Pişmiş', price: 0 }],
            note: 'Mantar soslu olsun',
          },
        ],
        totalPrice: 550.0 * (body.quantity || 1),
        totalDiscount: 50.0,
        checkoutPrice: 550.0 * (body.quantity || 1) - 50.0,
        paymentMethod: 'GETIR_ONLINE_PAYMENT',
      };
    } else if (platform === AggregatorPlatform.TRENDYOL) {
      samplePayload = {
        orderNumber: orderId,
        customerName: body.customerName || 'Zeynep Kaya',
        customerPhone: '05329876543',
        deliveryAddress: {
          fullAddress: body.deliveryAddress || 'Fenerbahçe Mah. Lale Sok. No: 12 Kadıköy',
          addressDescription: body.notes || 'Kapıda bırakınız',
        },
        lines: [
          {
            barcode: 'CLD-01',
            productName: body.productName || 'Mevsim Yeşillikleri Salata',
            quantity: body.quantity || 1,
            price: 180.0,
            totalPrice: 180.0 * (body.quantity || 1),
            modifierList: [{ name: 'Nar Ekşili', price: 0 }],
          },
        ],
        totalPrice: 180.0 * (body.quantity || 1),
        totalDiscount: 0,
        settlementPrice: 180.0 * (body.quantity || 1),
        paymentType: 'TRENDYOL_CZD',
      };
    } else {
      samplePayload = {
        id: orderId,
        customer: {
          firstName: body.customerName || 'Can',
          lastName: 'Demir',
          phone: '05441112233',
        },
        deliveryAddress: {
          addressText: body.deliveryAddress || 'Moda Cad. No: 15 Kadıköy',
          deliveryNotes: body.notes || '',
        },
        orderItems: [
          {
            sku: 'GRL-01',
            name: body.productName || 'Antrikot Izgara',
            quantity: body.quantity || 1,
            unitPrice: 550.0,
            totalPrice: 550.0 * (body.quantity || 1),
            specialInstructions: 'Sos ayrı gelsin',
          },
        ],
        totals: {
          subtotal: 550.0 * (body.quantity || 1),
          discount: 0,
          grandTotal: 550.0 * (body.quantity || 1),
        },
        paymentMethod: 'ONLINE_CREDIT_CARD',
      };
    }

    const result = await aggregatorService.handleIncomingWebhook(platform, samplePayload);

    return reply.code(201).send({
      success: true,
      simulatedPlatform: platform,
      orderId: result.orderId,
      externalOrder: result.externalOrder,
      canonical: result.canonical,
    });
  });

  /**
   * Update External Order Status (Courier dispatch, preparing, delivered)
   */
  fastify.post('/orders/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { status, riderName, riderPhone } = request.body as {
      status: AggregatorOrderStatus;
      riderName?: string;
      riderPhone?: string;
    };

    if (!status || !Object.values(AggregatorOrderStatus).includes(status)) {
      return reply.code(400).send({
        success: false,
        message: `Invalid status. Allowed: ${Object.values(AggregatorOrderStatus).join(', ')}`,
      });
    }

    const updated = await aggregatorService.updateOrderStatus(id, status, {
      name: riderName,
      phone: riderPhone,
    });

    return reply.send({
      success: true,
      externalOrder: updated,
    });
  });

  /**
   * Dynamic 86'ing: Synchronize out-of-stock across platforms
   */
  fastify.post('/stock-sync', async (request: FastifyRequest, reply: FastifyReply) => {
    const { productId, isAvailable } = request.body as {
      productId: string;
      isAvailable: boolean;
    };

    if (!productId || typeof isAvailable !== 'boolean') {
      return reply.code(400).send({
        success: false,
        message: 'Missing or invalid productId or isAvailable boolean flag',
      });
    }

    const result = await aggregatorService.syncOutOfStock(productId, isAvailable);

    return reply.send({
      success: true,
      message: `Dynamic 86'ing completed: item is now ${isAvailable ? 'AVAILABLE' : 'OUT_OF_STOCK'} across all aggregators`,
      result,
    });
  });

  /**
   * List External Delivery Orders
   */
  fastify.get('/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const orders = await aggregatorService.listExternalOrders(limit);

    return reply.send({
      success: true,
      count: orders.length,
      orders,
    });
  });
}
