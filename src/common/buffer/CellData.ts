/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { CharData, IBufferLine, ICellData, IExtendedAttrs } from 'common/Types';
import { stringFromCodePoint } from 'common/input/TextDecoder';
import { CHAR_DATA_CHAR_INDEX, CHAR_DATA_WIDTH_INDEX, CHAR_DATA_ATTR_INDEX, Content } from 'common/buffer/Constants';
import { AttributeData, ExtendedAttrs } from 'common/buffer/AttributeData';

/**
 * CellData - represents a single Cell in the terminal buffer.
 */
export class CellData extends AttributeData implements ICellData {
  /** Helper to create CellData from CharData. */
  public static fromCharData(value: CharData): CellData {
    const obj = new CellData();
    obj.setFromCharData(value);
    return obj;
  }
  public bufferLine: IBufferLine | undefined;

  /** Position and state in BufferLine.
   * The actual meaning of _stateA/_stateB/_stateM/_stateN depends on
   * on the actual class that implements bufferLine.
   * See the BufferLine class for the "default" implementation.
   * We use these place-holder fields in order to not have to allocate a
   * a specfic CellData object depending on the bufferLine class.
   */
  public _stateA: any;
  public _stateB: any;
  public _stateM: number = 0;
  public _stateN: number = 0;

 /** Position in BufferLine. OLD
   * The specific type and value depends on the bufferLine class.
   * For the default BufferLine the position is an integer:
   * 20 bit index in _data;
   * 20 bit collumn offset (relative to start of _data[index]. */
  //public position: any; // FIXME
  //private _dataIndex(): number { return this.position >> 20; }
  //private _columnOffset(): number { return this.position & 0xfffff; }
  public textStart: number = 0;
  public textEnd: number = 0;

  /** Primitives from terminal buffer. */
  public column = -1;
  public content = 0;
  public fg = 0;
  public bg = 0;
  public extended: IExtendedAttrs = new ExtendedAttrs();
  public combinedData = '';
  /** Whether cell contains a combined string. */
  public isCombined(): number {
    return this.content & Content.IS_COMBINED_MASK;
  }
  /** Width of the cell. */
  public getWidth(): number {
    return this.content >> Content.WIDTH_SHIFT;
  }
  /** JS string of the content. */
  public getChars(): string {
    if (this.textStart === this.textEnd || this.bufferLine === undefined)
      return '';
    return this.bufferLine._getChars(this);
    /*
    if (this.content & Content.IS_COMBINED_MASK) {
      return this.combinedData;
    }
    if (this.content & Content.CODEPOINT_MASK) {
      return stringFromCodePoint(this.content & Content.CODEPOINT_MASK);
    }
    return '';
    */
  }

  /**
   * Codepoint of cell
   * Note this returns the UTF32 codepoint of single chars,
   * if content is a combined string it returns the codepoint
   * of the last char in string to be in line with code in CharData.
   */
  public getCode(): number {
    return (this.isCombined())
      ? this.combinedData.charCodeAt(this.combinedData.length - 1)
      : this.content & Content.CODEPOINT_MASK;
  }
  /** Set data from CharData */
  public setFromCharData(value: CharData): void {
    this.fg = value[CHAR_DATA_ATTR_INDEX];
    this.bg = 0;
    let combined = false;
    // surrogates and combined strings need special treatment
    if (value[CHAR_DATA_CHAR_INDEX].length > 2) {
      combined = true;
    }
    else if (value[CHAR_DATA_CHAR_INDEX].length === 2) {
      const code = value[CHAR_DATA_CHAR_INDEX].charCodeAt(0);
      // if the 2-char string is a surrogate create single codepoint
      // everything else is combined
      if (0xD800 <= code && code <= 0xDBFF) {
        const second = value[CHAR_DATA_CHAR_INDEX].charCodeAt(1);
        if (0xDC00 <= second && second <= 0xDFFF) {
          this.content = ((code - 0xD800) * 0x400 + second - 0xDC00 + 0x10000) | (value[CHAR_DATA_WIDTH_INDEX] << Content.WIDTH_SHIFT);
        }
        else {
          combined = true;
        }
      }
      else {
        combined = true;
      }
    }
    else {
      this.content = value[CHAR_DATA_CHAR_INDEX].charCodeAt(0) | (value[CHAR_DATA_WIDTH_INDEX] << Content.WIDTH_SHIFT);
    }
    if (combined) {
      this.combinedData = value[CHAR_DATA_CHAR_INDEX];
      this.content = Content.IS_COMBINED_MASK | (value[CHAR_DATA_WIDTH_INDEX] << Content.WIDTH_SHIFT);
    }
  }
  /** Get data as CharData. */
  public getAsCharData(): CharData {
    return [this.fg, this.getChars(), this.getWidth(), this.getCode()];
  }
}
