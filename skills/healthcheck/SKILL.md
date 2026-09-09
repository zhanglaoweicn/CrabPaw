---
name: healthcheck
description: "系统安全检查与加固审计，覆盖防火墙、系统更新、账户安全、SSH、服务配置与网络基线，输出加固建议。当用户说“检查一下电脑安全”“系统安全体检”“做一次安全审计”时使用。"
metadata:
  crabpaw:
    category: general
    capabilities: [system_monitoring]
    emoji: 🔒
---

# Healthcheck

Perform system security audit and hardening checks.

## Checks Performed

### Windows
- Firewall status
- Windows Update settings
- User account security
- Service configurations
- Network security

### Linux/macOS
- Firewall status (ufw/firewalld/pf)
- SSH configuration
- Package updates
- User permissions
- Service security

## Usage

When user asks for system security check, perform the following:

### Windows Commands
```powershell
# Firewall status
Get-NetFirewallProfile | Select-Object Name, Enabled

# Windows Update service
Get-Service -Name wuauserv | Select-Object Status

# User accounts
Get-LocalUser | Select-Object Name, Enabled, LastLogon

# Running services
Get-Service | Where-Object {$_.Status -eq 'Running'} | Select-Object Name, DisplayName
```

### Linux Commands
```bash
# Firewall status (Ubuntu/Debian)
sudo ufw status

# SSH config check
sudo sshd -T | grep -E "permitrootlogin|passwordauthentication"

# Available updates
apt list --upgradable 2>/dev/null | head -20
```

### macOS Commands
```bash
# Firewall status
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# Gatekeeper status
spctl --status
```

## Risk Assessment

After gathering information, provide:
1. Security score (1-10)
2. Identified risks
3. Recommendations
4. Priority actions

## Notes

- Run with appropriate permissions
- Some checks require admin/sudo
- Document all findings
- Provide actionable recommendations
