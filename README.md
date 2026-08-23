<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Shiryu-Studios-LLC/devspace/main/docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/Shiryu-Studios-LLC/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Shiryu-Studios-LLC/devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Shiryu-Studios-LLC/devspace/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

[![DevSpace connected to ChatGPT](https://raw.githubusercontent.com/Shiryu-Studios-LLC/devspace/main/docs/assets/devspace-screenshot.png)](https://raw.githubusercontent.com/Shiryu-Studios-LLC/devspace/main/docs/assets/devspace-screenshot.png)

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

DevSpace is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading the entire repository to a separate code-hosting service. Content returned by MCP tools is sent to the connected model provider under that provider's terms. You run DevSpace on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

> [!IMPORTANT]
> This repository is the Shiryu Studios source of truth for its DevSpace
> deployment. It tracks the upstream `@waishnav/devspace` package while keeping
> the Windows control, Git, elevated admin bridge, and ChatGPT widget fixes used
> by Shiryu Studios in reviewed TypeScript source. Do not maintain production
> changes by patching the globally installed `node_modules` copy.

The installed package name remains `@waishnav/devspace`; this repository's
current package version is `1.0.7`. The npm badge describes the upstream package
name and registry release, not the contents of the deployed Shiryu build.

## Sponsors and Special Thanks
<!-- 

<table>
  <thead>
    <tr>
      <th>Sponsor</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://rebates.ai/">
          <img
            src="https://app.rebates.ai/brand/rebates-lockup.svg"
            alt="Rebates"
            width="170"
          >
        </a>
      </td>
      <td>
        <strong>The ads in your terminal pay you.</strong><br><br>
        <a href="https://rebates.ai/">Rebates</a> adds one optional
        sponsored footer to your coding agent and pays you cash back for every
        session in which it is shown. Turn it off at any time.
      </td>
    </tr>
  </tbody>
</table>
-->
<p>
  DevSpace is open to new sponsors.
  <a href="https://x.com/wshxnv">Get in touch to become one.</a>
</p>

## Installation

DevSpace requires Node `>=22.19 <27`.

Install the DevSpace CLI:

```bash
npm install -g @waishnav/devspace
```

### Install the Shiryu Studios build

For the Shiryu Studios deployment, build and install this repository instead
of replacing it with the public npm release:

```powershell
git clone https://github.com/Shiryu-Studios-LLC/devspace.git H:\Projects\devspace
Set-Location H:\Projects\devspace
npm install --include=dev
npm run typecheck
npm test
npm run build
npm pack
npm install -g .\waishnav-devspace-1.0.7.tgz
```

Existing deployments must preserve these files across upgrades:

```text
~/.devspace/config.json
~/.devspace/auth.json
~/.local/share/devspace/devspace.sqlite*
```

Do not run `devspace init --force` as an upgrade step. The configuration,
owner credential, and OAuth database live outside the npm package and should
not be regenerated during a source update. Stop the existing DevSpace server,
install the built checkout at the same global location, then restart it through
the deployment's normal service or scheduled-task wrapper.

Then initialize DevSpace:

```bash
devspace init
```

Or run it without a global install:

```bash
npx @waishnav/devspace init
```

During setup, DevSpace asks for:

- where you will use it: ChatGPT, Coding Agents, or both
- which Coding Agents DevSpace may use

If you select ChatGPT, setup also asks which local project folders it may open
and for your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy,
Tailscale Funnel, or another reverse proxy. A Coding Agents-only setup asks
neither question: local commands use the current Git project, or the current
directory outside a repository.

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.
Run `devspace serve` when using ChatGPT. For Coding Agents, setup prints a
`skills` command and lets the Skills CLI handle installation.

When the client connects, DevSpace opens an Owner password approval page. Enter
the Owner password printed by `devspace init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

> [!NOTE]
> Using DevSpace as an MCP connector isn't against OpenAI's Usage Policies — it's
> a standard custom App/connector setup, and writing or running code isn't a
> restricted use case. But your account is governed by your usage, not by
> DevSpace. Don't point it at anything that would violate your provider's terms.
> Used normally, you're fine. (Based on OpenAI's Usage Policies and Service Terms
> as of June 2026.)

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

DevSpace gives ChatGPT tools to:

- read, write, and edit files inside the opened workspace
- search code and inspect directories
- run shell commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel coding sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills from your skill folders
- show tool cards and optional change summaries in ChatGPT Apps-compatible hosts

## Shiryu Studios Extensions

The Shiryu Studios build adds the following tools to the core DevSpace MCP
surface.

### Windows screenshots and computer control

- `screenshot` and `minecraft_screenshot` capture the Windows virtual desktop
  to a workspace-relative PNG and return the image to the MCP host.
- `computer_windows`, `computer_focus_window`, and
  `computer_window_geometry` discover and target visible allowlisted windows.
- Keyboard and mouse tools support focused press, hold, release, typing, click,
  drag, scroll, and relative movement operations.
- Minecraft helpers provide focused keyboard, command, hotbar, interaction,
  item-use, and screenshot operations.

Computer control is Windows-only and revalidates the target window before each
action. The fixed executable allowlist is:

```text
Minecraft.Windows.exe
Unity.exe
UnrealEditor.exe
Blockbench.exe
```

Minecraft is the default target when a caller does not explicitly choose
another allowlisted application. The allowlist is a safety boundary; do not
replace it with arbitrary process execution.

### Dedicated Git tools

`git_status`, `git_add`, `git_commit`, `git_pull`, and `git_push` invoke Git
with argument arrays rather than interpolated shell commands. Workspace paths,
references, input sizes, timeouts, and output buffers are validated. Write
operations remain intentional, destructive-capable tools and Git hooks are
honored.

### Elevated admin bridge

`devspace_admin_status` and `devspace_admin_call` wrap the separately installed
Shiryu DevSpace Admin helper:

```text
C:\Program Files\Shiryu Studios\DevSpaceAdmin\devspace-adminctl.exe
```

Set `DEVSPACE_ADMIN_CTL` only when the verified helper is installed elsewhere.
The admin service is separate from the DevSpace MCP server and public tunnel.
The generic call tool does not grant undocumented actions: callers must use an
action supported by the installed helper and should treat every call as an
explicit elevated operation.

### ChatGPT widget domain

The workspace app resource publishes both its content-security policy and
`ui.domain`, derived from `publicBaseUrl`. This keeps the ChatGPT Apps widget
metadata consistent with the configured public origin and prevents the
`Widget domain is not set` validation failure.

## Local Agents

DevSpace includes an on-demand local-agent daemon, durable agent records,
provider adapters, named Markdown profiles, and isolated workspace support.
Agent execution is optional and independent from ordinary MCP workspace use.

Enable only providers you intend to use in `~/.devspace/config.json`, then
discover the actual usable targets instead of guessing:

```bash
devspace agents targets --json
devspace agents run <profile-or-provider> "<bounded brief>" --json
devspace agents show <agt_id> --json
devspace agents continue <agt_id> "<follow-up>" --json
devspace agents ls --json
```

The daemon starts on demand; users normally should not launch
`devspace-agentd` manually. Provider executables, authentication, models, and
usage limits remain owned by their provider. For example, a Codex worker logged
in through ChatGPT consumes the account's applicable Codex allowance. DevSpace
provides orchestration and context isolation, not free model inference or a way
around provider limits. A target appearing in the catalog proves configuration
and preflight availability, not that a real model turn has succeeded; validate
one small read-only run before depending on a provider.

Profiles are discovered from:

```text
~/.devspace/agents/*.md
<project>/.devspace/agents/*.md
```

See [Agent Profile Schema](docs/agent-profile-schema.md) and
[Local Agent Daemon](docs/local-agent-daemon.md) for lifecycle and failure
semantics. DevSpace also exposes first-class MCP orchestration tools when subagents are
enabled: `agent_spawn`, `agent_status`, `agent_list`, `agent_continue`, and
`agent_wait`. New and continued turns default to read-only access; callers must
explicitly request `allowed` or `full_access` when a delegated task needs to
modify the workspace. Per-agent cancellation is not yet exposed because provider
runtimes may be shared across sessions and must be interrupted through a
provider-aware cancellation contract rather than by terminating the whole daemon.

The local Shiryu deployment has verified provider discovery, but its first
Codex app-server turn has not completed successfully. Do not describe the Codex
worker path as production-verified until an end-to-end `agents run` and
`agents show` cycle completes. Ordinary MCP workspace, Git, admin, screenshot,
and Windows-control tools are independent of this status.

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `devspace serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

DevSpace supports Linux, macOS, and Windows. On Windows, command execution uses
the native command processor; PowerShell commands and existing `.ps1` scripts
can be invoked through the MCP command tool. The Shiryu Studios computer-control
extensions require Windows PowerShell and the Windows desktop APIs.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows                                           | Supported         | Native commands, PowerShell, Git, and Windows control tools. |

Run this to inspect your local setup:

```bash
devspace doctor
```

## Documentation

- [Setup Guide](docs/setup.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Agent Profile Schema](docs/agent-profile-schema.md)
- [Local Agent Daemon](docs/local-agent-daemon.md)
- [Native File Download](docs/artifact-exchange.md)
- [Security Model](docs/security.md)
- [Troubleshooting Gotchas](docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

My bet is that ChatGPT becomes the operating system for everything. Once we
reach AGI, we will simply talk to ChatGPT, and it will prompt, coordinate, and
orchestrate sub-agents that set up the right loops for us.

We are not there yet.

DevSpace is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

## Built by Waishnav

I'm Waishnav. I like building opinionated products and tools, and Artifacts is one example.

This year, I began my journey to build a one-person, multi-agent company capable of generating millions in revenue. If you want to follow the failures, wins, lessons, and everything in between, come hang out with me on [X](https://x.com/wshxnv).


## More from me

<table>
  <thead>
    <tr>
      <th>Project</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://gitcms.dev/">
          <img
            src="https://gitcms.dev/brand/gitcms-logo.svg"
            alt="GitCMS"
            width="48"
          /><br />
          <strong>GitCMS</strong>
        </a>
      </td>
      <td>
        <strong>Modern CMS and tooling for markdown based content sites — built for agents and humans.</strong><br><br>
        Visual editing, editorial workflow, and ChatGPT/Claude content agents, with
        every post and page stored as files in your repo.
        <a href="https://gitcms.dev/">Learn more</a>.
      </td>
    </tr>
  </tbody>
</table>

## Local Development

For working on DevSpace itself:

```bash
git clone https://github.com/Shiryu-Studios-LLC/devspace.git
cd devspace
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```

## Upgrade Checklist

Use this sequence for the maintained Shiryu deployment:

1. Back up `~/.devspace/config.json`, `~/.devspace/auth.json`, and the complete
   `~/.local/share/devspace/devspace.sqlite*` set without printing secrets.
2. Pull `main` from `Shiryu-Studios-LLC/devspace`.
3. Run `npm install --include=dev`, `npm run typecheck`, `npm test`, and
   `npm run build`.
4. Run `npm pack` and globally install the generated tarball.
5. Restart only the verified DevSpace server through its existing launcher;
   leave the public tunnel and separately installed admin service under their
   normal service ownership.
6. Verify local and public health, OAuth discovery, the unauthenticated MCP
   challenge, an authenticated `open_workspace`, Git and admin status, and one
   workspace-scoped screenshot.
7. Confirm the configuration and owner credential hashes are unchanged.

Never include the owner password, provider credentials, API keys, or tunnel
secrets in commits, command output, screenshots, or support reports.

## Upstream and Maintenance

DevSpace was created by [Waishnav](https://github.com/Waishnav/devspace). This
repository preserves that attribution and package identity while maintaining
the Shiryu Studios deployment-specific extensions in
[`src/local-windows-tools.ts`](src/local-windows-tools.ts),
[`src/git-tools.ts`](src/git-tools.ts), and
[`src/devspace-admin-tools.ts`](src/devspace-admin-tools.ts).
