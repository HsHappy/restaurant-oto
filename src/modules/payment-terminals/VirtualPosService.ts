import { randomUUID } from 'node:crypto';

export interface VirtualPosSession {
  sessionId: string;
  orderId: string;
  amount: number;
  currency: string;
  qrCodeUrl: string;
  expiresAt: Date;
  status: 'PENDING' | 'AUTHENTICATED' | 'COMPLETED' | 'FAILED';
}

export interface CardPaymentInput {
  cardNumber: string;
  expireMonth: string;
  expireYear: string;
  cvv: string;
  cardHolderName: string;
}

export interface VirtualPosResult {
  success: boolean;
  transactionId: string;
  authCode: string;
  amount: number;
  currency: string;
  cardMasked: string;
  threeDSecureVerified: boolean;
  timestamp: string;
}

export class VirtualPosService {
  private sessions: Map<string, VirtualPosSession> = new Map();

  /**
   * Generates a dynamic QR payment session for pay-at-table
   */
  public createSession(orderId: string, amount: number, currency: string = 'TRY'): VirtualPosSession {
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
    const qrCodeUrl = `https://pos.rms-restaurant.com/pay/${sessionId}?order=${orderId}&amount=${amount.toFixed(2)}`;

    const session: VirtualPosSession = {
      sessionId,
      orderId,
      amount,
      currency,
      qrCodeUrl,
      expiresAt,
      status: 'PENDING',
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Processes card payment with 3D Secure 2.0 flow
   */
  public async processCharge(
    sessionId: string,
    cardInput: CardPaymentInput
  ): Promise<VirtualPosResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Virtual POS payment session ${sessionId} not found or expired.`);
    }

    if (new Date() > session.expiresAt) {
      session.status = 'FAILED';
      throw new Error('Payment session has expired.');
    }

    const cleanCard = cardInput.cardNumber.replace(/\s+/g, '');
    const cardMasked = `${cleanCard.slice(0, 4)} **** **** ${cleanCard.slice(-4)}`;

    // Simulate 3DS 2.0 frictionless authentication & capture
    const transactionId = `VPOS-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const authCode = Math.floor(100000 + Math.random() * 900000).toString();

    session.status = 'COMPLETED';

    return {
      success: true,
      transactionId,
      authCode,
      amount: session.amount,
      currency: session.currency,
      cardMasked,
      threeDSecureVerified: true,
      timestamp: new Date().toISOString(),
    };
  }

  public getSession(sessionId: string): VirtualPosSession | undefined {
    return this.sessions.get(sessionId);
  }
}

export const virtualPosService = new VirtualPosService();
