/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { CircularList, IInsertEvent } from 'common/CircularList';
import { IdleTaskQueue } from 'common/TaskQueue';
import { IAttributeData, IBufferLine, ICellData, ICharset } from 'common/Types';
import { ExtendedAttrs } from 'common/buffer/AttributeData';
import { BufferLine, LogicalLine, DEFAULT_ATTR_DATA } from 'common/buffer/BufferLine';
import { CellData } from 'common/buffer/CellData';
import { NULL_CELL_CHAR, NULL_CELL_CODE, NULL_CELL_WIDTH, WHITESPACE_CELL_CHAR, WHITESPACE_CELL_CODE, WHITESPACE_CELL_WIDTH } from 'common/buffer/Constants';
import { Marker } from 'common/buffer/Marker';
import { IBuffer } from 'common/buffer/Types';
import { DEFAULT_CHARSET } from 'common/data/Charsets';
import { IBufferService, ILogService, IOptionsService } from 'common/services/Services';

export const MAX_BUFFER_SIZE = 4294967295; // 2^32 - 1

/**
 * This class represents a terminal buffer (an internal state of the terminal), where the
 * following information is stored (in high-level):
 *   - text content of this particular buffer
 *   - cursor position
 *   - scroll position
 */
export class Buffer implements IBuffer {
  public lines: CircularList<IBufferLine>;
  public ydisp: number = 0;
  public ybase: number = 0;
  /** Row number, relative to ybase. */
  public y: number = 0;
  public x: number = 0;
  public scrollBottom: number;
  public scrollTop: number;
  public tabs: { [column: number]: boolean | undefined } = {};
  public savedY: number = 0;
  public savedX: number = 0;
  public savedCurAttrData = DEFAULT_ATTR_DATA.clone();
  public savedCharset: ICharset | undefined = DEFAULT_CHARSET;
  public savedCharsets: (ICharset | undefined)[] = [];
  public savedGlevel: number = 0;
  public savedOriginMode: boolean = false;
  public savedWraparoundMode: boolean = true;

  /** Reflow may be needed for line indexes less than lastReflowNeeded.
   * I.e. if i >= lastReflowNeeded then lines.get(i).reflowNeeded is false.
   * Lines later in the buffer are more likely to be visible and hence
   * have been updated. */
  public lastReflowNeeded: number = 0;
  public markers: Marker[] = [];
  private _nullCell: ICellData = CellData.fromCharData([0, NULL_CELL_CHAR, NULL_CELL_WIDTH, NULL_CELL_CODE]);
  private _whitespaceCell: ICellData = CellData.fromCharData([0, WHITESPACE_CELL_CHAR, WHITESPACE_CELL_WIDTH, WHITESPACE_CELL_CODE]);
  private _cols: number;
  private _rows: number;
  private _isClearing: boolean = false;

  constructor(
    private _hasScrollback: boolean,
    private _optionsService: IOptionsService,
    private _bufferService: IBufferService,
    private readonly _logService: ILogService
  ) {
    this._cols = this._bufferService.cols;
    this._rows = this._bufferService.rows;
    this.lines = new CircularList<IBufferLine>(this._getCorrectBufferLength(this._rows));
    this.scrollTop = 0;
    this.scrollBottom = this._rows - 1;
    this.setupTabStops();
  }

  public getNullCell(attr?: IAttributeData): ICellData {
    if (attr) {
      this._nullCell.fg = attr.fg;
      this._nullCell.bg = attr.bg;
      this._nullCell.extended = attr.extended;
    } else {
      this._nullCell.fg = 0;
      this._nullCell.bg = 0;
      this._nullCell.extended = new ExtendedAttrs();
    }
    return this._nullCell;
  }

  public getWhitespaceCell(attr?: IAttributeData): ICellData {
    if (attr) {
      this._whitespaceCell.fg = attr.fg;
      this._whitespaceCell.bg = attr.bg;
      this._whitespaceCell.extended = attr.extended;
    } else {
      this._whitespaceCell.fg = 0;
      this._whitespaceCell.bg = 0;
      this._whitespaceCell.extended = new ExtendedAttrs();
    }
    return this._whitespaceCell;
  }

  public getBlankLine(attr: IAttributeData): IBufferLine {
    const lline = new LogicalLine(this._cols);
    const result = new BufferLine(this._cols, lline);
    result.fill(this.getNullCell(attr));
    return result;
  }

  public get hasScrollback(): boolean {
    return this._hasScrollback && this.lines.maxLength > this._rows;
  }

  public get isCursorInViewport(): boolean {
    const absoluteY = this.ybase + this.y;
    const relativeY = absoluteY - this.ydisp;
    return (relativeY >= 0 && relativeY < this._rows);
  }

  /**
   * Gets the correct buffer length based on the rows provided, the terminal's
   * scrollback and whether this buffer is flagged to have scrollback or not.
   * @param rows The terminal rows to use in the calculation.
   */
  private _getCorrectBufferLength(rows: number): number {
    if (!this._hasScrollback) {
      return rows;
    }

    const correctBufferLength = rows + this._optionsService.rawOptions.scrollback;

    return correctBufferLength > MAX_BUFFER_SIZE ? MAX_BUFFER_SIZE : correctBufferLength;
  }

  public setWrapped(absrow: number, value: boolean): void {
    const line = this.lines.get(absrow);
    if (! line || line.isWrapped === value)
    {return;}
    const prevRow = this.lines.get(absrow - 1) as BufferLine;
    if (value) {
      (line as BufferLine).setWrapped(prevRow);
    } else {
      (line as BufferLine).asUnwrapped(prevRow);
    }
  }

  /**G
   * Fills the buffer's viewport with blank lines.
   */
  public fillViewportRows(fillAttr?: IAttributeData): void {
    if (this.lines.length === 0) {
      if (fillAttr === undefined) {
        fillAttr = DEFAULT_ATTR_DATA;
      }
      let i = this._rows;
      while (i--) {
        this.lines.push(this.getBlankLine(fillAttr));
      }
    }
  }


  /**
   * Clears the buffer to it's initial state, discarding all previous data.
   */
  public clear(): void {
    this.ydisp = 0;
    this.ybase = 0;
    this.y = 0;
    this.x = 0;
    this.lines = new CircularList<IBufferLine>(this._getCorrectBufferLength(this._rows));
    this.scrollTop = 0;
    this.scrollBottom = this._rows - 1;
    this.setupTabStops();
  }

  /**
   * Resizes the buffer, adjusting its data accordingly.
   * @param newCols The new number of columns.
   * @param newRows The new number of rows.
   */
  public resize(newCols: number, newRows: number): void {
    // store reference to null cell with default attrs
    const nullCell = this.getNullCell(DEFAULT_ATTR_DATA);

    // Increase max length if needed before adjustments to allow space to fill
    // as required.
    const newMaxLength = this._getCorrectBufferLength(newRows);
    if (newMaxLength > this.lines.maxLength) {
      this.lines.maxLength = newMaxLength;
    }

    if (this._cols !== newCols) {
      const nlines = this.lines.length;
      for (let i = 0; i < nlines; i++) {
        const line = this.lines.get(i) as BufferLine;
        line.length = newCols;
        const logical = line.logicalLine;
        if (logical.firstBufferLine === line
          && (line.nextBufferLine || logical.length > newCols)) {
          logical.reflowNeeded = true;
          this.lastReflowNeeded = Math.max(i, this.lastReflowNeeded);
        }
      }
    }

    // The following adjustments should only happen if the buffer has been
    // initialized/filled.
    if (this.lines.length > 0) {
      // Deal with columns increasing (reducing needs to happen after reflow)
      for (let i = 0; i < this.lines.length; i++) {
        this.lines.get(i)!.length = newCols;
      }
      this.scrollTop = 0;
    }

    this.scrollBottom = newRows - 1;

    const lazyReflow = false; // FUTURE - change to true?
    const reflowNow = this._isReflowEnabled && this._cols !== newCols && ! lazyReflow;
    this._cols = newCols;
    this._rows = newRows;
    if((this as any).xyz) console.log('before reflowRegion');
    this.reflowRegion(reflowNow ? 0 : this.ydisp, this.lines.length,
      reflowNow? -1 : newRows);
    if((this as any).xyz) console.log('after reflowRegion');
    // Reduce max length if needed after adjustments, this is done after as it
    // would otherwise cut data from the bottom of the buffer.
    if (newMaxLength < this.lines.maxLength) {
      // Trim from the top of the buffer and adjust ybase and ydisp.
      const amountToTrim = this.lines.length - newMaxLength;
      if (amountToTrim > 0) {
        this.setWrapped(amountToTrim, false);
        this.lines.trimStart(amountToTrim);
        this.ybase = Math.max(this.ybase - amountToTrim, 0);
        this.ydisp = Math.max(this.ydisp - amountToTrim, 0);
        this.savedY = Math.max(this.savedY - amountToTrim, 0);
      }
      this.lines.maxLength = newMaxLength;
    }
    this._fixupPosition();
  }

  private get _isReflowEnabled(): boolean {
    const windowsPty = this._optionsService.rawOptions.windowsPty;
    if (windowsPty && windowsPty.buildNumber) {
      return this._hasScrollback && windowsPty.backend === 'conpty' && windowsPty.buildNumber >= 21376;
    }
    return this._hasScrollback && !this._optionsService.rawOptions.windowsMode;
  }

  public reflowRegion(startRow: number, endRow: number, maxRows: number): void {
    if (startRow > this.lastReflowNeeded) {
      return;
    }
    if (endRow >= this.lastReflowNeeded) {
      this.lastReflowNeeded = startRow;
    }
    const newCols = this._cols;
    while (startRow > 0 && this.lines.get(startRow)?.isWrapped) {
      startRow--;
      if (maxRows >= 0) { maxRows++; }
    }
    // POSSIBLE OPTIMIZATION: Don't need to allocate newRows if no lines
    // require more rows than before. So better to allocate newRows lazily.
    const newRows: BufferLine[] = [];
    const yDispOld = this.ydisp;
    const yBaseOld = this.ybase;
    const yAbsOld = yBaseOld + this.y;
    let yAbs = yAbsOld;
    const ySavedOld = this.savedY;
    let ySaved = ySavedOld;
    let deltaSoFar = 0;
    // Record buffer insert/delete events
    const insertEvents: IInsertEvent[] = [];
    let oldRows: (IBufferLine|undefined)[] = [];
    for (let j = 0; j < this.lines.length; j++) { oldRows.push(this.lines.get(j));}
    for (let row = startRow; row < endRow;) {
      if (maxRows >= 0 && newRows.length > maxRows) {
        endRow = row;
        break;
      }
      const line = this.lines.get(row) as BufferLine;
      newRows.push(line);
      const logical = line.logicalLine;

      if (logical.firstBufferLine === line && logical.reflowNeeded) {
        let curLine: BufferLine = line;

        let logicalX, logicalSavedX = this.savedX;
        let oldWrapCount = 0; // number of following wrapped lines
        let nextLine = curLine;
        for (; ; oldWrapCount++) {
          if (yAbsOld === row + oldWrapCount) {
            logicalX = nextLine.startColumn + this.x;
          }
          if (ySavedOld === row + oldWrapCount) {
            logicalSavedX = nextLine.startColumn + this.savedX;
          }
          if (! nextLine.nextBufferLine || row + oldWrapCount + 1 >= endRow) {
            break;
          }
          nextLine = nextLine.nextBufferLine;
        }
        const lineRow = row;
        row++;
        const newWrapStart = newRows.length;
        logical.reflowNeeded = false;
        let startCol = 0;
        // Loop over wrapped lines, based on newCols width.
        for (;;) {
          const endCol = logical.charStart(startCol + newCols);
          if (endCol >= logical.length) {
            curLine.nextBufferLine = undefined;
            curLine.startColumn = startCol;
            break;
          }
          const newRow1 = row < endRow && this.lines.get(row);
          // Re-use old wrapped line if available.
          const newLine = newRow1 instanceof BufferLine
 && newRow1.isWrapped ? (row++, newRow1)
            : new BufferLine(newCols, logical);
          newLine.startColumn = endCol;
          startCol = endCol;
          newRows.push(newLine);
          curLine.nextBufferLine = newLine;
          curLine = newLine;
        }
        // Skip old WrappedBufferLines that we no longer need.
        while (row < endRow
          && this.lines.get(row)?.isWrapped) {
          row++;
        }
        const newWrapCount = newRows.length - newWrapStart;
        if (yBaseOld >= lineRow && yBaseOld <= lineRow + oldWrapCount) {
          this.ybase = lineRow + deltaSoFar
            + Math.min(yBaseOld - lineRow, newWrapCount);
        }
        if (yDispOld >= lineRow && yDispOld <= lineRow + oldWrapCount) {
          this.ydisp = lineRow + deltaSoFar
            + Math.min(yDispOld - lineRow, newWrapCount);
        }
        if (logicalX !== undefined) { // update cursor x and y
          let i = newWrapStart;
          while (i < newRows.length && newRows[i].startColumn <= logicalX) { i++; }
          yAbs = startRow + i - 1 + deltaSoFar;
          this.x = logicalX - newRows[i-1].startColumn;
        }
        if (logicalSavedX !== undefined) { // update cursor savedX and savedY
          let i = newWrapStart;
          while (i < newRows.length && newRows[i].startColumn <= logicalSavedX) { i++; }
          ySaved = startRow + i - 1 + deltaSoFar;
          this.savedX = logicalSavedX - newRows[i-1].startColumn;
        }
        if (newWrapCount != oldWrapCount) {
          // Create insert events for later
          insertEvents.push({
            index: lineRow + deltaSoFar + 1,
            amount: newWrapCount - oldWrapCount
          });
        }
        deltaSoFar += newWrapCount - oldWrapCount;
      } else {
        if (row === yBaseOld) { this.ybase = yBaseOld + deltaSoFar; }
        if (row === yDispOld) { this.ydisp = yDispOld + deltaSoFar; }
        if (row === yAbsOld) {
          yAbs += deltaSoFar;
        }
        if (row === ySavedOld) {
          ySaved += deltaSoFar;
        }
        row++;
      }
    }
    if (deltaSoFar !== 0) {
      if (yAbsOld >= endRow) { yAbs += deltaSoFar; }
      if (ySavedOld >= endRow) { ySaved += deltaSoFar; }
      if (deltaSoFar > 0) {
        if (yBaseOld >= endRow) { this.ybase = yBaseOld + deltaSoFar; }
        if (yDispOld >= endRow) { this.ydisp = yDispOld + deltaSoFar; }
      }
    }
    this.y = yAbs - this.ybase;
    this.savedY = ySaved;
    const oldLinesCount = this.lines.length;
    let trimNeeded = oldLinesCount + newRows.length - (endRow - startRow)
      - this.lines.maxLength;
    let endTrimmed = 0;
    const belowEnd = this.lines.length - endRow;
    while (trimNeeded > 0) {
      const lrow = this.lines.length - 1;
      const last = this.lines.get(lrow);
      if (! (last instanceof BufferLine && ! last.isWrapped && last.logicalLine.length === 0)
        || yAbsOld === lrow || ySavedOld === lrow) {
        break;
      }
      trimNeeded--;
      endTrimmed++;
      this.lines.pop();
    }
    if (endTrimmed) {
      const newTrim = Math.max(endTrimmed - belowEnd, 0);
      newRows.length = newRows.length - newTrim;
      endRow -= newTrim;
      this.lines.onDeleteEmitter.fire({ index: this.lines.length, amount: endTrimmed });
    }
    this.lines.splice(startRow, endRow - startRow, ...newRows);
    /*
    this.lines.spliceNoTrim(startRow, endRow - startRow, newRows, false);
    // Update markers
    const insertCount = insertEvents.length;
    for (let i = 0; i < insertCount; i++) {
      const event = insertEvents[i];
      if (event.amount < 0) {
        event.amount = - event.amount;
        this.lines.onDeleteEmitter.fire(event);
      } else {
        this.lines.onInsertEmitter.fire(event);
      }
    }
    if (trimNeeded > 0) {
      this.ybase -= trimNeeded;
      this.ydisp -= trimNeeded;
      this.setWrapped(trimNeeded,false);
      this.lines.trimIfNeeded();
    }
    */
  }

  private _fixupPosition(): void {
    const cols = this._cols;
    const rows = this._rows;
    const ydispAtHome = this.ydisp === this.ybase;
    let ilast = this.lines.length - 1;
    while (ilast >= rows && this.ybase + this.y <ilast && this.savedY < ilast) {
      this.setWrapped(ilast, false);
      this.lines.pop();
      ilast--;
    }
    // FIXME migrate Windows conpty handling
    if (this.y >= rows) {
      const adjust = this.y - rows + 1;
      this.ybase += adjust;
      this.y -= adjust;
    }
    while (this.lines.length < rows) {
      this.lines.push(new BufferLine(cols));
    }
    const adjust = this.lines.length - this.ybase - rows;
    if (adjust < 0) {
      this.ybase += adjust;
      this.y -= adjust;
    }
    if (ydispAtHome) { this.ydisp = this.ybase; }
    this.ydisp = Math.max(0, Math.min(this.ydisp, this.lines.length));
  }

  /**
   * Translates a buffer line to a string, with optional start and end columns.
   * Wide characters will count as two columns in the resulting string. This
   * function is useful for getting the actual text underneath the raw selection
   * position.
   * @param lineIndex The absolute index of the line being translated.
   * @param trimRight Whether to trim whitespace to the right.
   * @param startCol The column to start at.
   * @param endCol The column to end at.
   */
  public translateBufferLineToString(lineIndex: number, trimRight: boolean, startCol: number = 0, endCol?: number): string {
    const line = this.lines.get(lineIndex);
    if (!line) {
      return '';
    }
    return line.translateToString(trimRight, startCol, endCol);
  }

  public getWrappedRangeForLine(y: number): { first: number, last: number } {
    let first = y;
    let last = y;
    // Scan upwards for wrapped lines
    while (first > 0 && this.lines.get(first)!.isWrapped) {
      first--;
    }
    // Scan downwards for wrapped lines
    while (last + 1 < this.lines.length && this.lines.get(last + 1)!.isWrapped) {
      last++;
    }
    return { first, last };
  }

  /**
   * Setup the tab stops.
   * @param i The index to start setting up tab stops from.
   */
  public setupTabStops(i?: number): void {
    if (i !== null && i !== undefined) {
      if (!this.tabs[i]) {
        i = this.prevStop(i);
      }
    } else {
      this.tabs = {};
      i = 0;
    }

    for (; i < this._cols; i += this._optionsService.rawOptions.tabStopWidth) {
      this.tabs[i] = true;
    }
  }

  /**
   * Move the cursor to the previous tab stop from the given position (default is current).
   * @param x The position to move the cursor to the previous tab stop.
   */
  public prevStop(x?: number): number {
    if (x === null || x === undefined) {
      x = this.x;
    }
    while (!this.tabs[--x] && x > 0);
    return x >= this._cols ? this._cols - 1 : x < 0 ? 0 : x;
  }

  /**
   * Move the cursor one tab stop forward from the given position (default is current).
   * @param x The position to move the cursor one tab stop forward.
   */
  public nextStop(x?: number): number {
    if (x === null || x === undefined) {
      x = this.x;
    }
    while (!this.tabs[++x] && x < this._cols);
    return x >= this._cols ? this._cols - 1 : x < 0 ? 0 : x;
  }


  /**
   * Clears markers on single line.
   * @param y The line to clear.
   */
  public clearMarkers(y: number): void {
    this._isClearing = true;
    for (let i = 0; i < this.markers.length; i++) {
      if (this.markers[i].line === y) {
        this.markers[i].dispose();
        this.markers.splice(i--, 1);
      }
    }
    this._isClearing = false;
  }

  /**
   * Clears markers on all lines
   */
  public clearAllMarkers(): void {
    this._isClearing = true;
    for (let i = 0; i < this.markers.length; i++) {
      this.markers[i].dispose();
    }
    this.markers.length = 0;
    this._isClearing = false;
  }

  public addMarker(y: number): Marker {
    const marker = new Marker(y);
    this.markers.push(marker);
    marker.register(this.lines.onTrim(amount => {
      marker.line -= amount;
      // The marker should be disposed when the line is trimmed from the buffer
      if (marker.line < 0) {
        marker.dispose();
      }
    }));
    marker.register(this.lines.onInsert(event => {
      if (marker.line >= event.index) {
        marker.line += event.amount;
      }
    }));
    marker.register(this.lines.onDelete(event => {
      // Delete the marker if it's within the range
      if (marker.line >= event.index && marker.line < event.index + event.amount) {
        marker.dispose();
      }

      // Shift the marker if it's after the deleted range
      if (marker.line > event.index) {
        marker.line -= event.amount;
      }
    }));
    marker.register(marker.onDispose(() => this._removeMarker(marker)));
    return marker;
  }

  private _removeMarker(marker: Marker): void {
    if (!this._isClearing) {
      this.markers.splice(this.markers.indexOf(marker), 1);
    }
  }

  /** Run some consistency checks on buffer.
   * Return '' if OK; otherwise error message.
   * Maybe move to TestUtils?
   */
  check(): string {
    let prevLine: BufferLine|undefined;
    const nlines = this.lines.length;
    for (let i = 0; i < nlines; i++) {
      const line = this.lines.get(i);
      if (! (line instanceof BufferLine))
        return `line ${i} is not a BufferLine`;
      if (prevLine && prevLine.nextBufferLine) {
        if (prevLine.nextBufferLine !== line)
          return `previous line ${i - 1} has next which is not line ${i}`;
        if (line.startColumn <= prevLine.startColumn)
          return `start column ${line.startColumn} of wrapped line ${i} is not greater than that of previous line`;
        if (line.logicalLine !== prevLine.logicalLine)
          return `wrapped line ${i} has different logicalLine than previous line`;
      } else if (line.logicalLine.firstBufferLine !== line)
        return `logicalLine.firstBufferLine of non-wrapped line ${i} is not this line`;
      if (i == nlines - 1 && line.nextBufferLine)
        return `last line ${i} has continuation line`;
      prevLine = line;
    }
    return '';
  }
}