import { randomUUID, createHash } from 'node:crypto';
import { db } from '../../infrastructure/database/db.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { UblXmlBuilder } from './UblXmlBuilder.js';
import { QrCodeGenerator } from './QrCodeGenerator.js';
import { FiscalDocument, TaxpayerInfo, OrderItem } from '../../core/domain/entities/index.js';
import { FiscalDocumentType, GibDocumentStatus } from '../../core/domain/enums/index.js';

export class FiscalService {
  private static instance: FiscalService;
  private documentCounter = 1;

  public static getInstance(): FiscalService {
    if (!FiscalService.instance) {
      FiscalService.instance = new FiscalService();
    }
    return FiscalService.instance;
  }

  /**
   * Generates and archives GİB e-Adisyon as soon as order is opened/confirmed
   */
  public async createEAdisyon(orderId: string): Promise<FiscalDocument> {
    const orderRes = await db.query(
      `SELECT o.*, b.name as branch_name, b.tax_number as branch_tax_number, b.tax_office as branch_tax_office,
              t.table_number
       FROM orders o
       JOIN branches b ON o.branch_id = b.id
       LEFT JOIN dining_tables t ON o.table_id = t.id
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new Error(`Order ${orderId} not found.`);
    }

    const order = orderRes.rows[0];

    // Fetch line items
    const itemsRes = await db.query(
      `SELECT oi.*, p.name as product_name 
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1 AND oi.status != 'CANCELLED'`,
      [orderId]
    );

    const items: OrderItem[] = itemsRes.rows;
    const documentUuid = randomUUID();
    const currentYear = new Date().getFullYear();
    const docNumber = `EAD${currentYear}${Date.now().toString().slice(-9)}`;

    const subtotal = Number(order.subtotal || items.reduce((acc, i) => acc + Number(i.total_price), 0));
    const grandTotal = Number(order.grand_total || subtotal);
    const vatTotal = Number((grandTotal * 0.1).toFixed(2)); // Standard 10% F&B VAT

    // 1. Build UBL-TR 1.2 XML
    const ublXml = UblXmlBuilder.buildInvoiceXml({
      documentType: FiscalDocumentType.E_ADISYON,
      documentNumber: docNumber,
      documentUuid,
      issueDate: new Date(),
      supplier: {
        taxNumber: order.branch_tax_number || '1234567890',
        title: order.branch_name || 'Restoran İşletmesi',
        taxOffice: order.branch_tax_office || 'Kadıköy',
      },
      customer: {
        vknTckn: '11111111111',
        title: order.table_number ? `Masa ${order.table_number}` : 'Paket Müşterisi',
      },
      items,
      subtotal,
      taxTotal: vatTotal,
      grandTotal,
      currency: 'TRY',
      note: `Adisyon No: ${order.order_number} | Masa: ${order.table_number || 'Paket'}`,
    });

    // 2. Generate GİB Fiscal QR Code data
    const qrCodeData = QrCodeGenerator.generate({
      taxNumber: order.branch_tax_number || '1234567890',
      documentNumber: docNumber,
      date: new Date(),
      totalPayable: grandTotal,
      totalVat: vatTotal,
      documentUuid,
    });

    // Compute cryptographic signature hash
    const signedHash = createHash('sha256').update(ublXml).digest('hex');

    // 3. Save to database
    await db.query(
      `INSERT INTO fiscal_documents (
        id, order_id, document_type, document_uuid, document_number,
        profile_id, total_payable_amount, tax_exclusive_amount, tax_total_amount,
        currency, ubl_xml, qr_code_data, gib_status_code, signed_hash, created_at, sent_to_gib_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())`,
      [
        randomUUID(),
        orderId,
        FiscalDocumentType.E_ADISYON,
        documentUuid,
        docNumber,
        'EADISYON',
        grandTotal,
        subtotal,
        vatTotal,
        'TRY',
        ublXml,
        qrCodeData,
        GibDocumentStatus.SUCCESS,
        signedHash,
      ]
    );

    const docRes = await db.query(`SELECT * FROM fiscal_documents WHERE document_uuid = $1`, [documentUuid]);
    const fiscalDoc = docRes.rows[0] as FiscalDocument;

    // 4. Publish Event
    await eventBus.publish('FISCAL:E_ADISYON_CREATED', orderId, {
      documentId: fiscalDoc.id,
      documentNumber: docNumber,
      documentUuid,
      grandTotal,
      qrCodeData,
    });

    return fiscalDoc;
  }

  /**
   * Finalizes e-Fatura or e-Arşiv invoice when bill is settled
   */
  public async finalizeInvoice(orderId: string, taxpayerInput?: TaxpayerInfo): Promise<FiscalDocument> {
    const orderRes = await db.query(
      `SELECT o.*, b.name as branch_name, b.tax_number as branch_tax_number, b.tax_office as branch_tax_office
       FROM orders o
       JOIN branches b ON o.branch_id = b.id
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new Error(`Order ${orderId} not found.`);
    }

    const order = orderRes.rows[0];

    // Determine taxpayer status (e-Fatura vs e-Arşiv)
    let isEInvoice = false;
    let taxpayer = taxpayerInput;

    if (taxpayer?.vkn_tckn) {
      const check = await this.checkTaxpayer(taxpayer.vkn_tckn);
      isEInvoice = check.is_e_invoice_taxpayer || false;
      if (!taxpayer.title) taxpayer.title = check.title;
    }

    const documentType = isEInvoice ? FiscalDocumentType.E_FATURA : FiscalDocumentType.E_ARSIV;
    const prefix = isEInvoice ? 'GIB' : 'EAR';
    const profileId = isEInvoice ? 'TICARIFATURA' : 'EARSIVFATURA';
    const currentYear = new Date().getFullYear();
    const docNumber = `${prefix}${currentYear}${Date.now().toString().slice(-9)}`;
    const documentUuid = randomUUID();

    // Fetch line items
    const itemsRes = await db.query(
      `SELECT oi.*, p.name as product_name 
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1 AND oi.status != 'CANCELLED'`,
      [orderId]
    );

    const items: OrderItem[] = itemsRes.rows;
    const subtotal = Number(order.subtotal || items.reduce((acc, i) => acc + Number(i.total_price), 0));
    const grandTotal = Number(order.grand_total || subtotal);
    const vatTotal = Number((grandTotal * 0.1).toFixed(2));

    // Build UBL-TR XML
    const ublXml = UblXmlBuilder.buildInvoiceXml({
      documentType,
      documentNumber: docNumber,
      documentUuid,
      issueDate: new Date(),
      supplier: {
        taxNumber: order.branch_tax_number || '1234567890',
        title: order.branch_name || 'Restoran İşletmesi',
        taxOffice: order.branch_tax_office || 'Kadıköy',
      },
      customer: {
        vknTckn: taxpayer?.vkn_tckn || '11111111111',
        title: taxpayer?.title || 'Perakende Müşteri',
        city: taxpayer?.address || 'İstanbul',
      },
      items,
      subtotal,
      taxTotal: vatTotal,
      grandTotal,
      currency: 'TRY',
      note: `Fatura Sipariş No: ${order.order_number}`,
    });

    const qrCodeData = QrCodeGenerator.generate({
      taxNumber: order.branch_tax_number || '1234567890',
      documentNumber: docNumber,
      date: new Date(),
      totalPayable: grandTotal,
      totalVat: vatTotal,
      documentUuid,
    });

    const signedHash = createHash('sha256').update(ublXml).digest('hex');

    // Save to database
    await db.query(
      `INSERT INTO fiscal_documents (
        id, order_id, document_type, document_uuid, document_number,
        profile_id, taxpayer_vkn_tckn, taxpayer_title, total_payable_amount,
        tax_exclusive_amount, tax_total_amount, currency, ubl_xml, qr_code_data,
        gib_status_code, signed_hash, created_at, sent_to_gib_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())`,
      [
        randomUUID(),
        orderId,
        documentType,
        documentUuid,
        docNumber,
        profileId,
        taxpayer?.vkn_tckn || null,
        taxpayer?.title || null,
        grandTotal,
        subtotal,
        vatTotal,
        'TRY',
        ublXml,
        qrCodeData,
        GibDocumentStatus.SUCCESS,
        signedHash,
      ]
    );

    const docRes = await db.query(`SELECT * FROM fiscal_documents WHERE document_uuid = $1`, [documentUuid]);
    const fiscalDoc = docRes.rows[0] as FiscalDocument;

    // Publish Event
    await eventBus.publish('FISCAL:INVOICE_CREATED', orderId, {
      documentId: fiscalDoc.id,
      documentType,
      documentNumber: docNumber,
      grandTotal,
      taxpayer: taxpayer?.title,
    });

    return fiscalDoc;
  }

  /**
   * Simulates GİB Taxpayer Lookup (Mükellefiyet Tespiti)
   * 10 digits = Corporate VKN (e-Invoice taxpayer if registered)
   * 11 digits = Individual TCKN (usually e-Archive)
   */
  public async checkTaxpayer(vknTckn: string): Promise<TaxpayerInfo> {
    const clean = vknTckn.trim();
    const isVkn = clean.length === 10;

    // Known registered corporate test VKNS or rule-based detection
    const isEInvoice = isVkn && !clean.startsWith('999');

    return {
      vkn_tckn: clean,
      title: isEInvoice ? `KURUMSAL A.Ş. (VKN: ${clean})` : `Bireysel Müşteri (${clean})`,
      tax_office: isVkn ? 'Boğaziçi Kurumlar V.D.' : 'Kadıköy V.D.',
      is_e_invoice_taxpayer: isEInvoice,
    };
  }

  public async getDocument(id: string): Promise<FiscalDocument | null> {
    const res = await db.query(`SELECT * FROM fiscal_documents WHERE id = $1 OR document_uuid = $2`, [id, id]);
    return res.rows[0] || null;
  }

  public async getDocumentsByOrder(orderId: string): Promise<FiscalDocument[]> {
    const res = await db.query(`SELECT * FROM fiscal_documents WHERE order_id = $1 ORDER BY created_at DESC`, [orderId]);
    return res.rows;
  }
}

export const fiscalService = FiscalService.getInstance();
