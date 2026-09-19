# DevSpace and its elevated partner as services

DevSpace's core MCP workspace, file, shell, Git, and OAuth server supports
Windows, macOS, and Linux. Build dependencies on the target OS and use a
supported Node version. Native dependencies cannot be copied between platforms.

The companion [DevSpaceAdmin installer](../../DevSpaceAdmin/README.md) installs
both services. Configure DevSpace first as your normal user (`devspace init`),
with explicit approved roots and your existing public HTTPS origin. The
installer preserves that configuration and the owner password.

| OS | Main server | Elevated partner | Service manager |
| --- | --- | --- | --- |
| Linux | Selected user | root | systemd |
| macOS | Selected user | root | launchd |
| Windows | Configured console user, launched by wrapper | LocalSystem | Windows SCM |

The Windows wrapper waits for its owner to sign in. Unix services start at
boot, subject to availability of user files and mounted project drives.
Graphical tools require a signed-in desktop session and OS permissions.
The existing Windows desktop/Minecraft extension is only registered on Windows;
it is not a portable desktop-control backend. Core coding/admin service support
does not imply that every OS has identical desktop or driver APIs.

Admin tool names and responses are the same across platforms. The helper path
defaults to `/usr/local/bin/devspace-adminctl` on Linux/macOS and
`C:\Program Files\Shiryu Studios\DevSpaceAdmin\devspace-adminctl.exe` on Windows.
The paired installer sets `DEVSPACE_ADMIN_CTL` and `DEVSPACE_ADMIN_TOOLS=1`.
Set `DEVSPACE_ADMIN_TOOLS=0` to disable the tools.

Long admin operations run asynchronously so other MCP requests remain
responsive. The broker owns command timeouts. Only the elevated partner runs
with administrative authority; ordinary shell commands remain user-level.

Do not run a user service and system service on the same DevSpace port. During
migration stop the old verified DevSpace service first, then start the new pair.
Cloudflare Tunnel remains a separately managed third service; these installers
do not change its DNS or lifecycle.
