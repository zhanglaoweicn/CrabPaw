---
name: system-info
description: "系统信息查询技能，获取操作系统、CPU、内存、磁盘、网络等硬件与资源信息。当用户问「电脑什么配置」「查系统信息」「内存多大」或诊断开发环境时使用。"
metadata:
  crabpaw:
    category: general
    capabilities: [system_info]
    emoji: 💻
---

# System Info

Get detailed system information.

## Quick Start

### Windows
```powershell
# Basic system info
systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type" /C:"Total Physical Memory"

# CPU info
wmic cpu get name,NumberOfCores,NumberOfLogicalProcessors

# Memory info
wmic memorychip get capacity,speed

# Disk info
wmic logicaldisk get size,freespace,caption

# Network info
ipconfig /all
```

### Linux
```bash
# OS info
cat /etc/os-release
uname -a

# CPU info
lscpu
cat /proc/cpuinfo | grep "model name" | head -1

# Memory info
free -h
cat /proc/meminfo | grep -E "MemTotal|MemAvailable"

# Disk info
df -h
lsblk

# Network info
ip addr show
```

### macOS
```bash
# System info
system_profiler SPSoftwareDataType

# Hardware info
system_profiler SPHardwareDataType

# CPU info
sysctl -n machdep.cpu.brand_string

# Memory info
sysctl hw.memsize
vm_stat

# Disk info
df -h
diskutil list
```

## Information Categories

1. **Operating System**
   - Name and version
   - Kernel version
   - Architecture

2. **Hardware**
   - CPU model and cores
   - Memory size
   - Disk space

3. **Network**
   - IP addresses
   - Network interfaces
   - DNS settings

4. **Resources**
   - CPU usage
   - Memory usage
   - Disk usage

## Usage

When user asks about system information, run appropriate commands based on OS and present the results in a clear, organized format.
