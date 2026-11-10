# Third-party licenses

This file records license notices for third-party code copied or vendored into
this repository's source tree.

It intentionally does not include license text for package-managed dependencies
from Go modules, npm/pnpm packages, Rust crates, or other lockfile-managed
ecosystems. Those dependencies are checked separately by
`scripts/license-check.sh` against the policy in `grant.yaml`; the generated
SBOM and Grant output are the dependency license report for package-managed
dependencies.

## Go Authors gopls / x/tools code

Vendored paths:

- `pkg/camber-helper/internal/gopls/**`
- `pkg/camber-helper/gopls/**`

Notice from vendored source files:

```text
Copyright (c) 2009 The Go Authors. All rights reserved.
```

License text from `pkg/camber-helper/internal/gopls/LICENSE`:

```text
Copyright (c) 2009 The Go Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Go MCP SDK OAuth extension code

Vendored path:

- `pkg/camber-helper/internal/mcp/oauthex/**`

Notice from vendored source files:

```text
Copyright 2025 The Go MCP SDK Authors. All rights reserved.
Use of this source code is governed by an MIT-style
license that can be found in the LICENSE file.
```

Upstream project: <https://github.com/modelcontextprotocol/go-sdk>

MIT license text:

```text
MIT License

Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.

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

## JetBrains Mono fonts (Nerd Fonts patched)

Bundled font paths:

- `ui/apps/desktop-assistant/public/fonts/JetBrainsMonoNerdFontMono-Bold.ttf`
- `ui/apps/desktop-assistant/public/fonts/JetBrainsMonoNerdFontMono-Regular.ttf`
- `ui/config/tailwind/public/jetbrains-mono-regular.woff2`

The `jetbrains-mono-regular.woff2` file is the JetBrains Mono typeface,
licensed under the SIL Open Font License, Version 1.1 (OFL-1.1). The
`JetBrainsMonoNerdFontMono-*` files are JetBrains Mono patched with additional
glyphs by the Nerd Fonts project. Nerd Fonts patched font files are also
licensed under OFL-1.1.

Notice from the JetBrains Mono project:

```text
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
```

License: SIL Open Font License, Version 1.1 (OFL-1.1).

Full license text: <https://openfontlicense.org/open-font-license-official-text/>

Upstream project: <https://github.com/JetBrains/JetBrainsMono>

Notice from the Nerd Fonts project:

```text
Copyright (c) 2014, Ryan L McIntyre (https://ryanlmcintyre.com).

This Font Software is licensed under the SIL Open Font License, Version 1.1.
```

Nerd Fonts project: <https://github.com/ryanoasis/nerd-fonts>

## Visual Studio Code declaration copies

Vendored/copied paths:

- `ui/apps/vscode-assistant/src/extension/contextproviders/gitExtension.d.ts`

Notice from these files:

```text
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the MIT License. See License.txt in the project root for license information.
```

MIT license text from the VS Code project:

```text
MIT License

Copyright (c) 2015 - present Microsoft Corporation

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
