export interface TranscriptMessage {
  role: 'user';
  text: string;
}

export class ComposerState {
  private codePoints: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = '';
  private lastSubmit = 0;
  readonly messages: TranscriptMessage[] = [];

  get input(): string {
    return this.codePoints.join('');
  }

  get cursorPosition(): number {
    return this.cursor;
  }

  get isEmpty(): boolean {
    return this.codePoints.length === 0;
  }

  insert(text: string): void {
    const points = Array.from(text);
    if (points.length === 0) return;
    this.codePoints.splice(this.cursor, 0, ...points);
    this.cursor += points.length;
  }

  backspace(): void {
    if (this.cursor <= 0) return;
    this.codePoints.splice(this.cursor - 1, 1);
    this.cursor -= 1;
  }

  deleteForward(): void {
    if (this.cursor >= this.codePoints.length) return;
    this.codePoints.splice(this.cursor, 1);
  }

  moveLeft(): void {
    if (this.cursor > 0) this.cursor -= 1;
  }

  moveRight(): void {
    if (this.cursor < this.codePoints.length) this.cursor += 1;
  }

  moveToStart(): void {
    this.cursor = 0;
  }

  moveToEnd(): void {
    this.cursor = this.codePoints.length;
  }

  submit(now: number = Date.now()): boolean {
    const text = this.input.trim();
    if (text.length === 0) return false;
    if (now - this.lastSubmit < 200) return false;
    this.lastSubmit = now;
    this.messages.push({ role: 'user', text });
    this.history.push(text);
    this.historyIndex = -1;
    this.codePoints = [];
    this.cursor = 0;
    this.draft = '';
    return true;
  }

  cancel(): void {
    this.codePoints = [];
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = '';
  }

  historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.draft = this.input;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return;
    }
    this.loadHistory();
  }

  historyDown(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.loadHistory();
    } else {
      this.historyIndex = -1;
      this.codePoints = Array.from(this.draft);
      this.cursor = this.codePoints.length;
      this.draft = '';
    }
  }

  private loadHistory(): void {
    const entry = this.history[this.historyIndex];
    if (entry === undefined) return;
    this.codePoints = Array.from(entry);
    this.cursor = this.codePoints.length;
  }
}
