# Third-party notices

Hola is licensed under PolyForm Internal Use 1.0.0 (see `LICENSE`). Parts of Hola are based on the following open-source work.

## DeepSeek Harness (dsh)

https://github.com/deepseek-ai/deepseek-harness

Wick, the harness Hola uses for API teammates (`lib/run.js`, `lib/tools.js`), reimplements in plain JavaScript several designs from DeepSeek Harness: background commands with completion notices, the plan checklist, repeated-call reminders, read-before-edit checks, line-ending-preserving edits, regex search, parallel read-only tools, cache-friendly pruning of old tool results, and mid-run compaction into a fixed-section checkpoint that reuses the conversation prefix. No dsh source files are included.

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## LobeHub Icons

Teammate avatars in `public/index.html` use vendor logos from LobeHub Icons (MIT); the notice is kept next to the symbols in that file.
