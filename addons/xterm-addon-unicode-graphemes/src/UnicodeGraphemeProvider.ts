/**
 * Copyright (c) 2023 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IUnicodeVersionProvider } from 'xterm';
import { getInfo, infoToWidth } from './UnicodeProperties';

type CharWidth = 0 | 1 | 2;


export class UnicodeGraphemeProvider implements IUnicodeVersionProvider {
  public readonly version = '15'; // FIXME import

  constructor() {
  }

  getUnicodeProperties(codePoint: number): number {
    return getInfo(codePoint);
  }
  propertiesToWidth(charInfo: number): CharWidth {
    return infoToWidth(charInfo);
  }
  public wcwidth(num: number): CharWidth {
    return infoToWidth(getInfo(num));
  }
}
