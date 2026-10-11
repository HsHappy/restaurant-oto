import { AggregatorPlatform } from '../../core/domain/enums/index.js';
import { CanonicalOrder, CanonicalOrderItem, CanonicalCustomer } from '../../core/domain/entities/index.js';

export class CanonicalOrderNormalizer {
  /**
   * Normalizes incoming raw webhook payloads from various food delivery platforms
   * into an unified, standard CanonicalOrder representation.
   */
  public static normalize(platform: AggregatorPlatform, rawPayload: any): CanonicalOrder {
    switch (platform) {
      case AggregatorPlatform.YEMEKSEPETI:
        return CanonicalOrderNormalizer.normalizeYemeksepeti(rawPayload);
      case AggregatorPlatform.GETIR:
        return CanonicalOrderNormalizer.normalizeGetir(rawPayload);
      case AggregatorPlatform.TRENDYOL:
        return CanonicalOrderNormalizer.normalizeTrendyol(rawPayload);
      case AggregatorPlatform.MIGROS_YEMEK:
        return CanonicalOrderNormalizer.normalizeMigrosYemek(rawPayload);
      default:
        return CanonicalOrderNormalizer.normalizeGeneric(platform, rawPayload);
    }
  }

  private static normalizeYemeksepeti(payload: any): CanonicalOrder {
    const customer: CanonicalCustomer = {
      name: `${payload.customer?.firstName || ''} ${payload.customer?.lastName || ''}`.trim() || 'Yemeksepeti Müşterisi',
      phone: payload.customer?.phone || payload.customer?.mobileNumber || '',
      delivery_address: payload.deliveryAddress?.addressText || payload.deliveryAddress?.fullAddress || '',
      notes: payload.deliveryAddress?.deliveryNotes || payload.notes || '',
    };

    const items: CanonicalOrderItem[] = (payload.orderItems || payload.items || []).map((item: any) => {
      const modifiers = (item.options || item.modifiers || []).map((mod: any) => ({
        name: mod.name || mod.optionName,
        extra_price: Number(mod.price || mod.extraPrice || 0),
      }));

      const quantity = Number(item.quantity || item.count || 1);
      const unitPrice = Number(item.unitPrice || item.price || 0);
      const modTotal = modifiers.reduce((acc: number, m: any) => acc + m.extra_price, 0);
      const totalPrice = Number(item.totalPrice || (unitPrice + modTotal) * quantity);

      return {
        sku: item.sku || item.productId || item.id,
        product_name: item.name || item.productName || 'Ürün',
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        selected_modifiers: modifiers,
        customer_notes: item.specialInstructions || item.note || '',
      };
    });

    const subtotal = Number(payload.totals?.subtotal || items.reduce((acc, i) => acc + i.total_price, 0));
    const discount = Number(payload.totals?.discount || payload.discounts?.total || 0);
    const grandTotal = Number(payload.totals?.grandTotal || payload.totalPrice || Math.max(0, subtotal - discount));

    return {
      platform: AggregatorPlatform.YEMEKSEPETI,
      external_order_id: String(payload.id || payload.orderId || payload.code),
      external_order_number: payload.code || payload.orderNumber || payload.id,
      customer,
      items,
      subtotal,
      discount_total: discount,
      grand_total: grandTotal,
      payment_method: payload.paymentMethod || 'ONLINE_CREDIT_CARD',
      package_pin: payload.packagePin || payload.pickupCode,
      requested_delivery_time: payload.requestedDeliveryTime,
      raw_payload: payload,
    };
  }

  private static normalizeGetir(payload: any): CanonicalOrder {
    const customer: CanonicalCustomer = {
      name: payload.client?.name || payload.customer?.name || 'Getir Müşterisi',
      phone: payload.client?.contactPhoneNumber || payload.client?.phone || '',
      delivery_address: payload.client?.deliveryAddress?.address || payload.deliveryAddress?.address || '',
      notes: payload.client?.deliveryAddress?.notes || payload.note || '',
    };

    const items: CanonicalOrderItem[] = (payload.products || payload.items || []).map((prod: any) => {
      const p = prod.product || prod;
      const modifiers = (prod.options || prod.selectedModifiers || []).map((opt: any) => ({
        name: opt.name || opt.optionName,
        extra_price: Number(opt.price || 0),
      }));

      const quantity = Number(prod.count || prod.quantity || 1);
      const unitPrice = Number(prod.price || p.price || 0);
      const modTotal = modifiers.reduce((acc: number, m: any) => acc + m.extra_price, 0);
      const totalPrice = Number(prod.totalPrice || (unitPrice + modTotal) * quantity);

      return {
        sku: p.id || prod.id || p.sku,
        product_name: p.name || prod.name || 'Getir Ürünü',
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        selected_modifiers: modifiers,
        customer_notes: prod.note || '',
      };
    });

    const subtotal = Number(payload.totalPrice || items.reduce((acc, i) => acc + i.total_price, 0));
    const discount = Number(payload.totalDiscount || 0);
    const grandTotal = Number(payload.checkoutPrice || Math.max(0, subtotal - discount));

    return {
      platform: AggregatorPlatform.GETIR,
      external_order_id: String(payload.id || payload.orderId),
      external_order_number: payload.confirmationId || payload.orderNumber || payload.id,
      customer,
      items,
      subtotal,
      discount_total: discount,
      grand_total: grandTotal,
      payment_method: payload.paymentMethod || 'GETIR_ONLINE_PAYMENT',
      package_pin: payload.packagePin || payload.confirmationId,
      requested_delivery_time: payload.deliveryTime,
      raw_payload: payload,
    };
  }

  private static normalizeTrendyol(payload: any): CanonicalOrder {
    const customer: CanonicalCustomer = {
      name: payload.customer?.fullName || payload.customerName || 'Trendyol Müşterisi',
      phone: payload.customer?.phone || payload.customerPhone || '',
      delivery_address: payload.deliveryAddress?.fullAddress || payload.deliveryAddress?.address || '',
      notes: payload.deliveryAddress?.addressDescription || payload.customerNote || '',
    };

    const items: CanonicalOrderItem[] = (payload.lines || payload.items || []).map((line: any) => {
      const modifiers = (line.modifierList || line.options || []).map((opt: any) => ({
        name: opt.name,
        extra_price: Number(opt.price || 0),
      }));

      const quantity = Number(line.quantity || 1);
      const unitPrice = Number(line.price || 0);
      const modTotal = modifiers.reduce((acc: number, m: any) => acc + m.extra_price, 0);
      const totalPrice = Number(line.totalPrice || (unitPrice + modTotal) * quantity);

      return {
        sku: line.barcode || line.sku || line.productId,
        product_name: line.productName || line.name || 'Trendyol Ürünü',
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        selected_modifiers: modifiers,
        customer_notes: line.notes || '',
      };
    });

    const subtotal = Number(payload.totalPrice || items.reduce((acc, i) => acc + i.total_price, 0));
    const discount = Number(payload.totalDiscount || 0);
    const grandTotal = Number(payload.settlementPrice || Math.max(0, subtotal - discount));

    return {
      platform: AggregatorPlatform.TRENDYOL,
      external_order_id: String(payload.id || payload.orderNumber),
      external_order_number: payload.orderNumber || payload.id,
      customer,
      items,
      subtotal,
      discount_total: discount,
      grand_total: grandTotal,
      payment_method: payload.paymentType || 'TRENDYOL_CZD',
      package_pin: payload.packagePin || payload.orderNumber?.slice(-4),
      raw_payload: payload,
    };
  }

  private static normalizeMigrosYemek(payload: any): CanonicalOrder {
    const customer: CanonicalCustomer = {
      name: payload.customerName || payload.customer?.name || 'Migros Yemek Müşterisi',
      phone: payload.customerPhone || payload.customer?.phone || '',
      delivery_address: payload.address?.fullAddress || payload.address || '',
      notes: payload.notes || '',
    };

    const items: CanonicalOrderItem[] = (payload.items || []).map((item: any) => {
      const modifiers = (item.options || []).map((o: any) => ({
        name: o.name,
        extra_price: Number(o.price || 0),
      }));

      const quantity = Number(item.quantity || 1);
      const unitPrice = Number(item.unitPrice || item.price || 0);
      const modTotal = modifiers.reduce((acc: number, m: any) => acc + m.extra_price, 0);
      const totalPrice = Number(item.totalPrice || (unitPrice + modTotal) * quantity);

      return {
        sku: item.sku || item.id,
        product_name: item.name || 'Migros Yemek Ürünü',
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        selected_modifiers: modifiers,
        customer_notes: item.note || '',
      };
    });

    const subtotal = Number(payload.subtotal || items.reduce((acc, i) => acc + i.total_price, 0));
    const discount = Number(payload.discount || 0);
    const grandTotal = Number(payload.grandTotal || Math.max(0, subtotal - discount));

    return {
      platform: AggregatorPlatform.MIGROS_YEMEK,
      external_order_id: String(payload.orderId || payload.orderCode || payload.id),
      external_order_number: payload.orderCode || payload.orderId,
      customer,
      items,
      subtotal,
      discount_total: discount,
      grand_total: grandTotal,
      payment_method: payload.paymentMethod || 'MIGROS_ONLINE',
      package_pin: payload.pin,
      raw_payload: payload,
    };
  }

  private static normalizeGeneric(platform: AggregatorPlatform, payload: any): CanonicalOrder {
    const customer: CanonicalCustomer = {
      name: payload.customer?.name || payload.customerName || 'Müşteri',
      phone: payload.customer?.phone || payload.customerPhone || '',
      delivery_address: payload.customer?.delivery_address || payload.deliveryAddress || '',
      notes: payload.customer?.notes || payload.notes || '',
    };

    const items: CanonicalOrderItem[] = (payload.items || []).map((item: any) => ({
      sku: item.sku || item.id,
      product_name: item.product_name || item.name || 'Ürün',
      quantity: Number(item.quantity || 1),
      unit_price: Number(item.unit_price || item.price || 0),
      total_price: Number(item.total_price || (item.unit_price || 0) * (item.quantity || 1)),
      selected_modifiers: item.selected_modifiers || [],
      customer_notes: item.customer_notes || '',
    }));

    const subtotal = Number(payload.subtotal || items.reduce((acc, i) => acc + i.total_price, 0));
    const discount = Number(payload.discount_total || 0);
    const grandTotal = Number(payload.grand_total || Math.max(0, subtotal - discount));

    return {
      platform,
      external_order_id: String(payload.external_order_id || payload.id || `ORD-${Date.now()}`),
      external_order_number: payload.external_order_number || payload.orderNumber || payload.id,
      customer,
      items,
      subtotal,
      discount_total: discount,
      grand_total: grandTotal,
      payment_method: payload.payment_method || 'ONLINE',
      package_pin: payload.package_pin,
      raw_payload: payload,
    };
  }
}
