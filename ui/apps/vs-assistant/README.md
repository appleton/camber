# Visual Studio extension

The Camber Visual Studio extension uses CefSharp to embed the web apps for
the docked conversations pane and ACP chat. It also bundles the Camber helper
and calls it through the OmniSharp LSP Client.

To install the prebuilt Visual Studio extension, see
[Install the Visual Studio extension](../../../INSTALL.md#visual-studio-extension).

After installing, open **Tools > Camber Assistant > Focus Input**. For setting
up agents, adding connectors, and starting your first conversation, see
[Getting started with Camber Assistant](../../../docs/getting-started.md).

For the general source-build flow, see
[Run the Visual Studio extension](../../../INSTALL.md#run-the-visual-studio-extension).
Linux-host and Windows-VM development notes are below.

## Development setup

If you get to a working development setup different from what is documented
here, please add some notes about it!

### Linux host, Windows VM

1. Set up a Windows virtual machine. Unless an ARM64 port has appeared since
   this was written, the VM needs to have AMD64 architecture. VirtualBox has
   been observed to work well, but any setup that supports a shared drive should
   suffice.
2. Install Visual Studio 2022, and make sure that you pick the extension
   development workload in the setup.
3. Create a shared drive with this repository as its root.
4. On the host system, in the `app/` directory, first run
   `pnpm run download:binaries` to fetch the highest published `helper/v*`
   runtime produced by a VS Code or Desktop release (this needs the `gh` CLI
   authenticated), then run
   `pnpm run build` to build the web applications for the assistant and ACP
   chat windows. `pnpm run build` does **not** download the helper on its own.
5. In the virtual machine, open the `.sln` file in Visual Studio. Press the
   play button to build and run it.
6. Use `git` from the host system when possible. To keep diffs readable and
   avoid `^M` at the end of every line, edit `.git/config` and add
   `whitespace = cr-at-eol` to the `[core]` section.

### Prebuilt VSIX from CI

The **Build VSIX** workflow packages a complete extension — webview bundle and
helper included — for every push and pull request that touches this directory.
The `camber-assistant-vsix` artifact on the run is installable, so reviewing
or testing a change does not always need a local Windows build. It is unsigned
and its version is whatever the manifest currently says, so it is for testing
only, never for distribution.

## Tips

- Visual Studio convention puts debugging and support options on the Help menu.
  These options include viewing the helper log output, copying the helper
  protocol dump to the clipboard, and opening Chrome DevTools for the assistant
  window.
- When you run the extension from Visual Studio during development, it is
  installed into an experimental instance of the IDE. There is a Start Menu
  item to reset this instance, if you want to get it back to a clean state
  (named Reset the Visual Studio 2022 Experimental Instance).
- A VSIX file is mostly a ZIP file, and installing an extension primarily
  unzips it. You can test a different helper version or a different assistant
  or ACP chat app build by copying it into the installed extension directory.
  To find the directory, go to
  `C:\Users\<you>\AppData\Local\Microsoft\VisualStudio`. The subdirectories
  correspond to your installed Visual Studio versions. Experimental instances
  also get their own directories.
- Unlike VS Code, Visual Studio and .NET use a multi-threaded environment.
  Anything that touches the UI or UI-adjacent models must happen on the UI
  thread. CefSharp runs its own threads, so incoming messages often need a
  thread transition. In an `async` method, use `await` to switch to the main
  thread. The codebase also includes runtime assertions for UI-thread access
  and a compile-time check for code paths that must be guarded by an assertion
  or a thread switch.
- Visual Studio extensions use several API families, and no single API covers
  everything. MEF creates and injects instances automatically. DTE is
  higher-level and often easier to use, but incomplete. Some APIs call into C++
  code and may require manual resource management. The editor is built with
  WPF, and the extension also uses Roslyn for C# and Visual Basic integration.
- The APIs can be sparse or inconsistent. Code search on GitHub using interface
  names is often the best way to find useful examples. API docs exist, but can
  be terse once you get off the beaten path.
- Visual Studio's build system can be flaky, especially when shared drives are
  involved. Before switching branches, close and
  reopen the solution. If you get odd build errors, try reloading the solution
  and running **Build > Clean Solution**, or restart Visual Studio.
- Visual Studio stability varies when Windows runs in a virtual machine. Some
  setups work well. Others show intermittent errors when starting the
  experimental instance.

## Helper type OpenAPI generation

NSwag is also used to generate types for the Camber helper. It does not
generate a client because the helper is not an HTTP API; the generated types are
used with the OmniSharp LSP client. The generated types are committed, so you
only need to follow these instructions when you update them.

Use the helper type update script. In the Visual Studio `Tools` menu, choose
`Command Prompt`, then `Developer Command Prompt`. Then run:

```bat
update-helper-types.bat
```

This runs the `camber-helper openapi` subcommand, installs the NSwag generator
if needed, runs it, then shuts down the helper.

## Update the helper

Run `pnpm run download:binaries` in the `app` directory. It resolves the highest
published release in the independent `helper/v*` lineage. Set
`CAMBER_HELPER_VERSION=helper/vM.m.p` to reproduce or test an exact helper
release. Follow the instructions above when helper API types also changed.

## Nightly releases from CI

The coordinated release train (`.github/workflows/release-products.yml`) can
release the extension as the `vs` product. A nightly release is an unsigned
VSIX published to GitHub Releases as a prerelease under a `vs-assistant/vX.Y.Z`
tag, with the signed helper from the shared `helper/v*` runtime inside.
Publication is gated on the `VS_RELEASES_ENABLED` and
`NIGHTLY_RELEASES_ENABLED` repository variables. Stable Marketplace releases
still follow the manual process below, but `make release-visual-studio`
records their tags in the same `vs-assistant/v*` lineage, so the nightly
planner continues from the latest stable version (for example, the first
nightly after stable 1.6.0 is 1.7.0). The retired `vs/v*` tags are not read
by the planner.

The release planner never invents the first version. A manual release through
`make release-visual-studio` binds the `vs-assistant/v*` tag lineage on its
own; to start nightlies before the first such release, bootstrap the lineage
once by planning an exact nightly version (odd minor) against the main tip and
pushing the annotated tag it produces:

```bash
cd ui/scripts/release-helper
plan=$(pnpm -s find-version plan vs --channel nightly --version 1.5.0 \
  --ref origin/main --tag-prefix vs-assistant \
  --destination "$(../../apps/vs-assistant/scripts/extension-identity.sh)" \
  --create-lineage)
git tag --annotate --message "$(jq -r '.tagAnnotation' <<<"$plan")" \
  "$(jq -r '.tag' <<<"$plan")" "$(jq -r '.sourceSha' <<<"$plan")"
git push origin "$(jq -r '.tag' <<<"$plan")"
```

Then run the **Release · Visual Studio** workflow right away, before main
moves: it resumes the reserved tag and publishes its GitHub release. Scheduled
nightlies take over from there.

## Make a release

### Code signing setup

If this is your first release, set up code signing first. We use SSL.com's
eSigner cloud-based code signing service.

1. Ensure you have an SSL.com account that is part of the Camber team, and
   that the code signing certificate is enrolled in eSigner (this is done in
   the SSL.com portal under Signing Credentials). **Important:** The "malware
   blocker" setting must be disabled on the signing credential, otherwise
   signing will fail with "hash needs to be scanned first" errors.

2. Install the [SSL.COM eSigner CKA](https://www.ssl.com/downloads/#cka)
   (Cloud Key Adapter). This installs a Cryptographic Service Provider that
   lets Windows signing tools use your cloud-hosted certificate.

3. During eSigner CKA installation, you will be prompted to log in with your
   SSL.com credentials. This authenticates you and makes the certificate
   available through the Windows Certificate Store. Choose **Automated**
   signing mode if you want to sign without entering an OTP each time.
   Manual mode requires authenticator app confirmation for each signing
   operation.

4. Find your certificate thumbprint:
   - Press `Win+R` and run `certmgr.msc`
   - Navigate to **Personal > Certificates**
   - Double-click your SSL.com code signing certificate
   - Go to the **Details** tab and scroll to **Thumbprint**
   - Copy the value (remove any spaces)

5. Either set up an environment variable (restart your command prompt after):
   ```bat
   setx SSLCOM_THUMBPRINT "<thumbprint>"
   ```
   Or pass the thumbprint directly when running the signing script.

### Choose the next version number

If this is a preview release and it currently has an even minor version,
increment it to the next minor number and a 0 patch, for example from 1.0.5
to 1.1.0. If the minor is already odd, increment the patch, for example from
1.1.0 to 1.1.1.

If this is not a preview release and it currently has an odd minor version,
increment it to the next minor number and add a 0 patch, for example from
1.1.1 to 1.2.0. If the minor is already even, increment the patch, for example
from 1.2.5 to 1.2.6.

### Build and publish the release

1. Create a branch `release-visual-studio-x.y.z` (with the version number)
2. Open the manifest in Visual Studio.
3. Update the version number
4. Make sure the "This release is in preview" checkbox is set correctly
   depending on if you want a preview release or not. (The version number
   pattern is an internal convention. This flag is what matters.)
5. Update the version number and dependencies in `./app/package.json`
6. Make a commit with the version bump, push it, and open a pull request
7. Wait for the release notes to be produced (they will appear in a comment
   in the pull request).
8. Update the `ReleaseNotes.html` with the generated release notes.
9. Commit the release notes changes and push.
10. Merge the release PR. The release tag joins the managed `vs-assistant/v*`
    lineage, whose planner requires the released commit to be on `main`.
11. Check out `main`, pull the merged release commit, and in the repository
    root run `make release-visual-studio`.
12. Back in the Windows Virtual Machine, set the configuration to "Release",
    and do a build.
13. Sign the VSIX. In a Developer Command Prompt, run:
    ```bat
    sign-vsix.bat
    ```
14. Close Visual Studio. Find the newly built release (in the `bin\Release\net472`
    folder, named `camber-assistant.vsix`). Install it into your Visual
    Studio instance.
15. Open Visual Studio. Run some test prompt to make sure it works OK after
    install.
16. Back on your host machine, press enter to complete the automated part of
    the release process, which pushes the annotated `vs-assistant/vX.Y.Z` tag
    and uploads the release to GitHub.
17. Upload the release to the Visual Studio Marketplace (the numbered file will
    be in `bin\Release`).
