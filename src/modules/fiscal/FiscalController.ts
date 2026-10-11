import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fiscalService } from './FiscalService.js';
import { TaxpayerInfo } from '../../core/domain/entities/index.js';

export async function fiscalRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Generate GİB e-Adisyon for Order
   */
  fastify.post('/eadisyon/:orderId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { orderId } = request.params as { orderId: string };
    const doc = await fiscalService.createEAdisyon(orderId);

    return reply.code(201).send({
      success: true,
      message: 'GİB e-Adisyon document successfully generated and archived',
      document: {
        id: doc.id,
        documentNumber: doc.document_number,
        documentUuid: doc.document_uuid,
        profileId: doc.profile_id,
        totalPayable: doc.total_payable_amount,
        vatTotal: doc.tax_total_amount,
        qrCodeData: doc.qr_code_data,
        signedHash: doc.signed_hash,
        gibStatus: doc.gib_status_code,
      },
    });
  });

  /**
   * Finalize e-Fatura / e-Arşiv Invoice
   */
  fastify.post('/invoice/:orderId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { orderId } = request.params as { orderId: string };
    const taxpayer = request.body as TaxpayerInfo | undefined;

    const doc = await fiscalService.finalizeInvoice(orderId, taxpayer);

    return reply.code(201).send({
      success: true,
      message: `GİB ${doc.document_type} successfully generated and queued`,
      document: {
        id: doc.id,
        documentType: doc.document_type,
        documentNumber: doc.document_number,
        documentUuid: doc.document_uuid,
        taxpayerTitle: doc.taxpayer_title,
        totalPayable: doc.total_payable_amount,
        qrCodeData: doc.qr_code_data,
        signedHash: doc.signed_hash,
      },
    });
  });

  /**
   * Lookup Taxpayer for e-Fatura compliance
   */
  fastify.get('/taxpayer-check/:vkn', async (request: FastifyRequest, reply: FastifyReply) => {
    const { vkn } = request.params as { vkn: string };
    const info = await fiscalService.checkTaxpayer(vkn);

    return reply.send({
      success: true,
      taxpayer: info,
    });
  });

  /**
   * Get Fiscal Document details
   */
  fastify.get('/documents/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const doc = await fiscalService.getDocument(id);

    if (!doc) {
      return reply.code(404).send({ success: false, message: 'Fiscal document not found' });
    }

    return reply.send({
      success: true,
      document: doc,
    });
  });

  /**
   * Download raw UBL-TR 1.2 XML string
   */
  fastify.get('/documents/:id/xml', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const doc = await fiscalService.getDocument(id);

    if (!doc) {
      return reply.code(404).send({ success: false, message: 'Fiscal document not found' });
    }

    return reply.type('application/xml').send(doc.ubl_xml);
  });

  /**
   * Get all fiscal documents for an order
   */
  fastify.get('/order/:orderId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { orderId } = request.params as { orderId: string };
    const docs = await fiscalService.getDocumentsByOrder(orderId);

    return reply.send({
      success: true,
      count: docs.length,
      documents: docs,
    });
  });
}
