/**
 * Generates GİB (Gelir İdaresi Başkanlığı) standard Fiscal QR Code string
 * Format according to GİB e-Adisyon and e-Belge Technical Guidelines.
 */
export interface QrCodeParams {
  taxNumber: string; // VKN or TCKN
  documentNumber: string; // e.g. EAD2026000000001
  date: Date;
  totalPayable: number;
  totalVat: number;
  documentUuid: string;
}

export class QrCodeGenerator {
  public static generate(params: QrCodeParams): string {
    const formattedDate = params.date.toISOString().split('T')[0];
    const formattedTime = params.date.toTimeString().split(' ')[0];

    // Standard GİB pipe-delimited payload
    const parts = [
      `VKN:${params.taxNumber}`,
      `TARIH:${formattedDate} ${formattedTime}`,
      `NO:${params.documentNumber}`,
      `TUTAR:${params.totalPayable.toFixed(2)}`,
      `KDV:${params.totalVat.toFixed(2)}`,
      `UUID:${params.documentUuid}`,
    ];

    return parts.join('|');
  }
}
