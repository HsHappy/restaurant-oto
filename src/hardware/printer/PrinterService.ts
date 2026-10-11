import { EscPosBuilder } from './EscPosBuilder.js';
import { networkPrinter } from './NetworkPrinter.js';
import { Order, OrderItem, Branch } from '../../core/domain/entities/index.js';

export interface PrintReceiptOptions {
  openDrawer?: boolean;
  host?: string;
  port?: number;
}

export class PrinterService {
  private defaultHost: string;
  private defaultPort: number;
  private defaultKitchenHost: string;
  private defaultKitchenPort: number;

  constructor() {
    this.defaultHost = process.env.PRINTER_HOST || '127.0.0.1';
    this.defaultPort = parseInt(process.env.PRINTER_PORT || '9100', 10);
    this.defaultKitchenHost = process.env.KITCHEN_PRINTER_HOST || '127.0.0.1';
    this.defaultKitchenPort = parseInt(process.env.KITCHEN_PRINTER_PORT || '9100', 10);
  }

  /**
   * Generates and prints customer bill receipt (Adisyon / Fiş)
   */
  public async printReceipt(
    order: Order,
    branch: Branch,
    options: PrintReceiptOptions = {}
  ): Promise<{ success: boolean; jobId: string; queued: boolean; message?: string }> {
    const builder = new EscPosBuilder();

    // 1. Header
    builder
      .align('CENTER')
      .size(2, 2)
      .bold(true)
      .line(branch.name.toUpperCase())
      .size(1, 1)
      .bold(false)
      .line(`VKN: ${branch.tax_number} - ${branch.tax_office || 'Merkez'}`)
      .line('TARIH / SAAT: ' + new Date().toLocaleString('tr-TR'))
      .separator('=');

    // 2. Order Metadata
    builder
      .align('LEFT')
      .line(`Masa: ${order.table_number || 'Paket/Hızlı'}    Adisyon: ${order.order_number}`)
      .line(`Garson ID: ${order.waiter_id.slice(0, 8)}...`)
      .separator('-');

    // 3. Line Items
    if (order.items && order.items.length > 0) {
      for (const item of order.items) {
        const itemTotalStr = item.is_complimentary ? 'IKRAM (0.00 TL)' : `${Number(item.total_price).toFixed(2)} TL`;
        const itemName = `${item.quantity}x ${item.product_name || 'Urun'}`;
        builder.columns(itemName, itemTotalStr);

        // Modifiers if any
        if (item.selected_modifiers && item.selected_modifiers.length > 0) {
          for (const mod of item.selected_modifiers) {
            const modStr = `  + ${mod.name}`;
            const modPriceStr = mod.extra_price > 0 ? `+${Number(mod.extra_price).toFixed(2)} TL` : '';
            builder.columns(modStr, modPriceStr);
          }
        }
      }
    }

    builder.separator('-');

    // 4. Totals and Discounts
    builder.columns('ARA TOPLAM:', `${Number(order.subtotal).toFixed(2)} TL`);
    if (Number(order.discount_total) > 0) {
      builder.columns('INDIRIM / ISKONTO:', `-${Number(order.discount_total).toFixed(2)} TL`);
    }
    builder.columns('KDV TOPLAMI:', `${Number(order.tax_total).toFixed(2)} TL`);
    builder.separator('=');

    // 5. Grand Total
    builder
      .bold(true)
      .size(2, 2)
      .columns('TOPLAM:', `${Number(order.grand_total).toFixed(2)} TL`)
      .size(1, 1)
      .bold(false);

    // 6. Payments
    if (order.payments && order.payments.length > 0) {
      builder.separator('-');
      builder.line('ODEME DETAYI:');
      for (const pay of order.payments) {
        builder.columns(`  ${pay.payment_method}`, `${Number(pay.amount).toFixed(2)} ${pay.currency}`);
      }
    }

    // 7. Footer & Fiscal Note
    builder
      .separator('=')
      .align('CENTER')
      .line('MALI DEGERI YOKTUR - BILGI FISIDIR')
      .line('Bizi tercih ettiginiz icin tesekkur ederiz!')
      .feed(2);

    // 8. Cut paper
    builder.cut();

    // 9. Optional Cash Drawer Pulse
    if (options.openDrawer) {
      builder.pulseDrawer();
    }

    const host = options.host || this.defaultHost;
    const port = options.port || this.defaultPort;

    return await networkPrinter.sendRaw(host, port, builder.build(), 'RECEIPT');
  }

  /**
   * Generates and prints kitchen ticket for specified station (Grill, Bar, Oven, etc.)
   */
  public async printKitchenTicket(
    station: string,
    tableNumber: string,
    waiterId: string,
    items: OrderItem[],
    orderNumber: string,
    options: { host?: string; port?: number } = {}
  ): Promise<{ success: boolean; jobId: string; queued: boolean; message?: string }> {
    const builder = new EscPosBuilder();

    // Kitchen Header
    builder
      .align('CENTER')
      .size(2, 2)
      .bold(true)
      .line(`*** MUTFAK - ${station.toUpperCase()} ***`)
      .size(1, 1)
      .bold(false)
      .line(`MASA: ${tableNumber}   ADISYON: ${orderNumber}`)
      .line(`Zaman: ${new Date().toLocaleTimeString('tr-TR')}  Garson: ${waiterId.slice(0, 8)}`)
      .separator('=');

    // Items
    builder.align('LEFT');
    for (const item of items) {
      builder
        .bold(true)
        .size(1, 2)
        .line(`[ ] ${item.quantity}x ${item.product_name || 'Urun'}`)
        .size(1, 1)
        .bold(false);

      if (item.selected_modifiers && item.selected_modifiers.length > 0) {
        for (const mod of item.selected_modifiers) {
          builder.line(`     NOT: ${mod.name}`);
        }
      }
      builder.line('');
    }

    builder.separator('-');
    builder.feed(2).cut();

    const host = options.host || this.defaultKitchenHost;
    const port = options.port || this.defaultKitchenPort;

    return await networkPrinter.sendRaw(host, port, builder.build(), 'KITCHEN');
  }

  /**
   * Generates and sends Cash Drawer Open signal (DLE DC4 / ESC p)
   */
  public async openCashDrawer(
    options: { host?: string; port?: number } = {}
  ): Promise<{ success: boolean; jobId: string; queued: boolean; message?: string }> {
    const builder = new EscPosBuilder();
    builder.pulseDrawer();

    const host = options.host || this.defaultHost;
    const port = options.port || this.defaultPort;

    return await networkPrinter.sendRaw(host, port, builder.build(), 'DRAWER_PULSE');
  }

  /**
   * Generates and prints delivery ticket for online food aggregators (Getir, Yemeksepeti, Trendyol)
   */
  public async printDeliveryTicket(
    platform: string,
    orderNumber: string,
    customer: { name: string; phone?: string; delivery_address?: string; notes?: string },
    items: OrderItem[],
    packagePin?: string,
    grandTotal: number = 0,
    options: { host?: string; port?: number } = {}
  ): Promise<{ success: boolean; jobId: string; queued: boolean; message?: string }> {
    const builder = new EscPosBuilder();

    // Delivery Header
    builder
      .align('CENTER')
      .size(2, 2)
      .bold(true)
      .line(`*** ${platform.toUpperCase()} PAKET SERVIS ***`)
      .size(1, 1)
      .bold(false)
      .line(`SIPARIS NO: ${orderNumber}`)
      .line('TARIH: ' + new Date().toLocaleString('tr-TR'))
      .separator('=');

    // Customer & Delivery Address
    builder
      .align('LEFT')
      .bold(true)
      .line(`Musteri : ${customer.name}`)
      .line(`Telefon : ${customer.phone || 'Belirtilmedi'}`)
      .bold(false);

    if (customer.delivery_address) {
      builder.line(`Adres   : ${customer.delivery_address}`);
    }
    if (customer.notes) {
      builder.bold(true).line(`Musteri Notu: ${customer.notes}`).bold(false);
    }
    if (packagePin) {
      builder.bold(true).size(2, 1).line(`TESLIMAT PIN KODU: ${packagePin}`).size(1, 1).bold(false);
    }
    builder.separator('-');

    // Line Items
    builder.line('SIPARIS DETAYI:');
    for (const item of items) {
      const itemText = `${item.quantity}x ${item.product_name || 'Urun'}`;
      const priceText = `${Number(item.total_price).toFixed(2)} TL`;
      builder.columns(itemText, priceText);

      if (item.selected_modifiers && item.selected_modifiers.length > 0) {
        for (const mod of item.selected_modifiers) {
          builder.line(`  + ${mod.name}`);
        }
      }
      if (item.customer_notes) {
        builder.line(`  Not: ${item.customer_notes}`);
      }
    }

    builder.separator('=');
    builder
      .size(2, 2)
      .bold(true)
      .columns('TOPLAM:', `${Number(grandTotal).toFixed(2)} TL`)
      .size(1, 1)
      .bold(false);

    builder.separator('-');
    builder.align('CENTER').line('Lutfen kurye tesliminde pini kontrol ediniz.').feed(2).cut();

    const host = options.host || this.defaultHost;
    const port = options.port || this.defaultPort;

    return await networkPrinter.sendRaw(host, port, builder.build(), 'DELIVERY_TICKET');
  }
}

export const printerService = new PrinterService();
