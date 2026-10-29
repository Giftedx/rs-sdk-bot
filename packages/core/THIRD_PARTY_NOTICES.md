# SDK worker execution and bank-operation references

`worker-execution.ts` adapts the cancelled-call boundary in
`MaxBittker/rs-sdk`, `mcp/execute-code.ts::tracked`, with its existing
`sdk/execution-context.ts` runner scope. Hosted entry isolation, native session
cleanup and durable cargo attempt cursors are local rewrites. Source pins and
failure evidence are in `.practice/deep-reuse/sdk/`.

MIT License

Copyright (c) 2025 Lost City

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

## SDL event dispatch reference

`inprocess.ts` rewrites the fixed dispatch membership and removal handling in
`libsdl-org/SDL` commit `c7b85f68820195b714cfcde1f2509456a833611a`,
`src/events/SDL_eventwatch.c::SDL_DispatchEventWatchList`, for JavaScript tick
listeners. This is an altered implementation, not SDL source. Its real shim
regression is `test/inprocess.test.ts`: a wait created during a tick must wait
for the next tick, while removed listeners must stay removed.

Simple DirectMedia Layer
Copyright (C) 1997-2026 Sam Lantinga <slouken@libsdl.org>

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

## jopt-simple argument validation reference

`host.ts::parseHostArgs` rewrites required-argument and typed-value checks from
`jopt-simple/jopt-simple` commit `1f80fe268d2b038b44702ac12cdc95e5060a92b1`,
`RequiredArgumentOptionSpec.java` and `ArgumentAcceptingOptionSpec.java`.
The local CLI rejects missing, duplicate, unknown and out-of-range launch
options before running a worker. No Java parser or dependency is included.

Copyright (c) 2004-2021 Paul R. Holser, Jr.

The MIT License terms reproduced above apply to this reference.
