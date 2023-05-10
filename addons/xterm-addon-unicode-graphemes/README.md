## xterm-addon-unicode-graphemes

An addon providing enhanced Unicode support (include grapheme clustering) for xterm.js.

### Install

```bash
npm install --save xterm-addon-unicode-graphemes
```

### Usage

```ts
import { Terminal } from 'xterm';
import { UnicodeGraphemeAddon } from 'xterm-addon-unicode-graphemes';

const terminal = new Terminal();
const unicodeGraphemeAddon = new UnicodeGraphemeAddon();
terminal.loadAddon(unicodeGraphemeAddon);

// activate the new version
terminal.unicode.activeVersion = '15';
```
