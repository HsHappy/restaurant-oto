/**
 * ESC/POS Binary Command Generator
 * Implements standard Epson ESC/POS protocol specifications.
 */
export class EscPosBuilder {
  private buffer: Buffer[] = [];

  // Command constants
  private static readonly ESC = 0x1b;
  private static readonly GS = 0x1d;
  private static readonly FS = 0x1c;
  private static readonly DLE = 0x10;

  constructor() {
    this.initialize();
  }

  /** ESC @ : Initialize printer */
  public initialize(): this {
    this.buffer.push(Buffer.from([EscPosBuilder.ESC, 0x40]));
    return this;
  }

  /** ESC a n : Select justification (0 = Left, 1 = Center, 2 = Right) */
  public align(alignment: 'LEFT' | 'CENTER' | 'RIGHT'): this {
    const val = alignment === 'CENTER' ? 1 : alignment === 'RIGHT' ? 2 : 0;
    this.buffer.push(Buffer.from([EscPosBuilder.ESC, 0x61, val]));
    return this;
  }

  /** GS ! n : Select character size (Double width/height, normal) */
  public size(widthMultiplier: 1 | 2 = 1, heightMultiplier: 1 | 2 = 1): this {
    const w = (widthMultiplier - 1) << 4;
    const h = heightMultiplier - 1;
    const n = w | h;
    this.buffer.push(Buffer.from([EscPosBuilder.GS, 0x21, n]));
    return this;
  }

  /** ESC E n : Turn emphasized (bold) mode on/off */
  public bold(enable: boolean = true): this {
    this.buffer.push(Buffer.from([EscPosBuilder.ESC, 0x45, enable ? 1 : 0]));
    return this;
  }

  /** Print raw text encoded in windows-1254 or utf-8 fallback */
  public text(str: string): this {
    // Turkish characters and text handling
    this.buffer.push(Buffer.from(str, 'utf-8'));
    return this;
  }

  /** Print text followed by newline */
  public line(str: string = ''): this {
    this.text(str + '\n');
    return this;
  }

  /** Print two columns: left aligned and right aligned (total width = 42 chars for standard 80mm thermal paper) */
  public columns(left: string, right: string, totalWidth: number = 42): this {
    const spaceCount = Math.max(1, totalWidth - (left.length + right.length));
    const formatted = left + ' '.repeat(spaceCount) + right;
    this.line(formatted);
    return this;
  }

  /** Print separator line */
  public separator(char: string = '-', length: number = 42): this {
    this.line(char.repeat(length));
    return this;
  }

  /** Feed lines */
  public feed(lines: number = 2): this {
    this.buffer.push(Buffer.from([EscPosBuilder.ESC, 0x64, lines]));
    return this;
  }

  /** GS V A n : Select cut mode and cut paper */
  public cut(feedLines: number = 3): this {
    this.feed(feedLines);
    this.buffer.push(Buffer.from([EscPosBuilder.GS, 0x56, 0x41, 0x03]));
    return this;
  }

  /** Pulse cash drawer: DLE DC4 0x01 0x00 0x05 OR ESC p 0 25 250 */
  public pulseDrawer(): this {
    // Standard DLE DC4 drawer kick
    this.buffer.push(Buffer.from([EscPosBuilder.DLE, 0x14, 0x01, 0x00, 0x05]));
    // Secondary standard ESC p 0 25 250
    this.buffer.push(Buffer.from([EscPosBuilder.ESC, 0x70, 0x00, 0x19, 0xfa]));
    return this;
  }

  /** Build and return complete binary Buffer */
  public build(): Buffer {
    return Buffer.concat(this.buffer);
  }
}
