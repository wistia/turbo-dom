export class DOMRectReadOnly {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    Object.defineProperties(this, {
      __x: { value: Number(x), writable: true }, __y: { value: Number(y), writable: true },
      __width: { value: Number(width), writable: true }, __height: { value: Number(height), writable: true },
    });
  }
  static fromRect(rect = {}) {
    rect ??= {};
    if (typeof rect !== 'object' && typeof rect !== 'function') throw new TypeError('Expected a rectangle dictionary');
    return new this(rect.x, rect.y, rect.width, rect.height);
  }
  get x() { return this.__x; }
  get y() { return this.__y; }
  get width() { return this.__width; }
  get height() { return this.__height; }
  get top() { return Math.min(this.y, this.y + this.height); }
  get right() { return Math.max(this.x, this.x + this.width); }
  get bottom() { return Math.max(this.y, this.y + this.height); }
  get left() { return Math.min(this.x, this.x + this.width); }
  toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left }; }
}
export class DOMRect extends DOMRectReadOnly {
  get x() { return this.__x; } set x(value) { this.__x = Number(value); }
  get y() { return this.__y; } set y(value) { this.__y = Number(value); }
  get width() { return this.__width; } set width(value) { this.__width = Number(value); }
  get height() { return this.__height; } set height(value) { this.__height = Number(value); }
}
