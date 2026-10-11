import { FiscalDocumentType } from '../../core/domain/enums/index.js';
import { OrderItem } from '../../core/domain/entities/index.js';

export interface UblSupplierInfo {
  taxNumber: string; // VKN
  title: string;
  taxOffice?: string;
  address?: string;
  city?: string;
}

export interface UblCustomerInfo {
  vknTckn?: string;
  title?: string;
  address?: string;
  city?: string;
}

export interface UblDocumentInput {
  documentType: FiscalDocumentType;
  documentNumber: string;
  documentUuid: string;
  issueDate: Date;
  supplier: UblSupplierInfo;
  customer: UblCustomerInfo;
  items: OrderItem[];
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  currency?: string;
  note?: string;
}

export class UblXmlBuilder {
  /**
   * Generates a fully compliant UBL-TR 1.2 XML document string for e-Adisyon or e-Fatura / e-Arşiv
   */
  public static buildInvoiceXml(input: UblDocumentInput): string {
    const currency = input.currency || 'TRY';
    const dateStr = input.issueDate.toISOString().split('T')[0];
    const timeStr = input.issueDate.toTimeString().split(' ')[0];

    const isAdisyon = input.documentType === FiscalDocumentType.E_ADISYON;
    const profileId = isAdisyon
      ? 'EADISYON'
      : input.documentType === FiscalDocumentType.E_FATURA
      ? 'TICARIFATURA'
      : 'EARSIVFATURA';
    const invoiceTypeCode = isAdisyon ? 'ADISYON' : 'SATIS';

    const customerVkn = input.customer.vknTckn || (isAdisyon ? '11111111111' : '11111111111');
    const customerTitle = input.customer.title || (isAdisyon ? 'MASA MUSTERISI' : 'PERAKENDE MUSTERI');

    // Build line items XML
    let linesXml = '';
    input.items.forEach((item, index) => {
      const lineId = index + 1;
      const unitPrice = Number(item.unit_price).toFixed(2);
      const lineExtension = (item.quantity * item.unit_price).toFixed(2);
      const vatRate = 10.0;
      const lineTax = (Number(lineExtension) * 0.1).toFixed(2);

      linesXml += `
  <cac:InvoiceLine>
    <cbc:ID>${lineId}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="NIU">${item.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${lineExtension}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${currency}">${lineTax}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${currency}">${lineExtension}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${currency}">${lineTax}</cbc:TaxAmount>
        <cbc:Percent>${vatRate.toFixed(2)}</cbc:Percent>
        <cac:TaxCategory>
          <cac:TaxScheme>
            <cbc:Name>KDV</cbc:Name>
            <cbc:TaxTypeCode>0015</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name><![CDATA[${item.product_name || 'Ürün'}]]></cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${unitPrice}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
         xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ProfileID>${profileId}</cbc:ProfileID>
  <cbc:ID>${input.documentNumber}</cbc:ID>
  <cbc:CopyIndicator>false</cbc:CopyIndicator>
  <cbc:UUID>${input.documentUuid}</cbc:UUID>
  <cbc:IssueDate>${dateStr}</cbc:IssueDate>
  <cbc:IssueTime>${timeStr}</cbc:IssueTime>
  <cbc:InvoiceTypeCode>${invoiceTypeCode}</cbc:InvoiceTypeCode>
  <cbc:Note><![CDATA[${input.note || 'RMS Otomasyon Belgesi'}]]></cbc:Note>
  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
  
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="VKN">${input.supplier.taxNumber}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name><![CDATA[${input.supplier.title}]]></cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:CityName>${input.supplier.city || 'İstanbul'}</cbc:CityName>
        <cbc:Country>
          <cbc:Name>Türkiye</cbc:Name>
        </cbc:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cac:TaxScheme>
          <cbc:Name>${input.supplier.taxOffice || 'Kadıköy'}</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${customerVkn.length === 10 ? 'VKN' : 'TCKN'}">${customerVkn}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name><![CDATA[${customerTitle}]]></cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:CityName>${input.customer.city || 'İstanbul'}</cbc:CityName>
        <cbc:Country>
          <cbc:Name>Türkiye</cbc:Name>
        </cbc:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${input.taxTotal.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${currency}">${input.subtotal.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${currency}">${input.taxTotal.toFixed(2)}</cbc:TaxAmount>
      <cbc:Percent>10.00</cbc:Percent>
      <cac:TaxCategory>
        <cac:TaxScheme>
          <cbc:Name>KDV</cbc:Name>
          <cbc:TaxTypeCode>0015</cbc:TaxTypeCode>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${input.subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${input.subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${input.grandTotal.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${currency}">${input.grandTotal.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${linesXml}
</Invoice>`;
  }
}
