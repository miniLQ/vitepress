---
outline: deep
---

# Wired Channel Switch 模块分析

## 1. 模块定位与核心价值

wired_channel_switch 是华为充电管理系统中的 **有线充电通道切换管理模块**，负责控制不同充电路径（BUCK、LVC、SC、SC4 等）的开关状态。它是一个**三层架构设计**，包含抽象层、管理层和实现层。

**核心价值：**
- 🔄 **多路径切换**：管理 6 种充电通道（BUCK、LVC、LVC_MOS、SC、SC_AUX、SC4）
- 👥 **多客户端管理**：支持 6 类客户端（无线、有线、OTG、无线发射、低功耗、反向充电）投票决策
- 🛡️ **互斥保护**：防止多个充电路径同时开启，避免硬件冲突
- 🎯 **集中管理**：统一的通道切换接口，简化上层调用

## 2. 系统架构

### 2.1 三层架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    应用层 (调用者)                             │
├─────────────────────────────────────────────────────────────┤
│  无线充电 │ 有线充电 │ OTG │ 无线发射 │ 低功耗 │ 直充 │...    │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                          ▼
┌─────────────────────┐    ┌──────────────────────┐
│ wired_channel_      │    │ wired_channel_       │
│    switch.c         │    │   manager.c          │
│   (抽象接口层)       │    │   (投票管理层)        │
├─────────────────────┤    ├──────────────────────┤
│ • 注册 ops          │    │ • 多客户端投票        │
│ • 路由调用          │◄───┤ • BUCK 通道仲裁      │
│ • 无线发射联动      │    │ • 强制/普通模式       │
└──────────┬──────────┘    └──────────────────────┘
           │
      ┌────┴────┬──────────────┐
      ▼         ▼              ▼
┌──────────┐ ┌───────────┐ ┌──────────┐
│   OVP    │ │  NCP3902  │ │  Mixed   │
│  Switch  │ │  Switch   │ │   OVP    │
│ (实现层) │ │ (实现层)  │ │ (实现层) │
├──────────┤ ├───────────┤ ├──────────┤
│ GPIO控制 │ │ GPIO控制  │ │ GPIO控制 │
│ 多通道   │ │ BUCK单通道│ │ 混合模式 │
│ 约束管理 │ │ 反向通道  │ │          │
└──────────┘ └───────────┘ └──────────┘
```

### 2.2 充电通道类型

| 通道类型 | 说明 | 典型应用场景 |
|---------|------|------------|
| WIRED_CHANNEL_BUCK | BUCK 降压充电通道 | 5V/9V 普通充电 |
| WIRED_CHANNEL_LVC | 低压直充通道 | 低压直充（2:1） |
| WIRED_CHANNEL_LVC_MOS | LVC MOS 开关 | LVC 路径控制 |
| WIRED_CHANNEL_SC | 超级快充通道 | 高压直充（4:1） |
| WIRED_CHANNEL_SC_AUX | SC 辅助通道 | SC 备份路径 |
| WIRED_CHANNEL_SC4 | 4:1 直充通道 | 超级快充 4.0 |
| WIRED_CHANNEL_ALL | 所有通道 | 整体控制 |

### 2.3 客户端类型（WDCM）

| 客户端 | 说明 | ON 状态 | OFF 状态 | 强制标志 |
|-------|------|---------|---------|---------|
| WDCM_CLIENT_WLS | 无线充电 | CUTOFF | CUTOFF | 无 |
| WDCM_CLIENT_WIRED | 有线充电 | RESTORE | RESTORE | **强制** |
| WDCM_CLIENT_OTG | OTG 输出 | CUTOFF | RESTORE | 无 |
| WDCM_CLIENT_TX_OTG | 无线发射 OTG | CUTOFF | RESTORE | 无 |
| WDCM_CLIENT_LPM | 低功耗模式 | CUTOFF | RESTORE | 无 |
| WDCM_CLIENT_TX_RVSSC | 反向充电 | RESTORE | RESTORE | 无 |

## 3. 核心数据结构

### 3.1 通道切换操作接口

```c
struct wired_chsw_device_ops {
    // 设置指定通道状态
    int (*set_wired_channel)(int channel_type, int state);
    
    // 设置其他通道状态（排除指定通道）
    int (*set_other_wired_channel)(int channel_type, int state);
    
    // 获取通道当前状态
    int (*get_wired_channel)(int channel_type);
    
    // 设置反向充电通道（NCP3902 特有）
    int (*set_wired_reverse_channel)(int state);
};
```

### 3.2 通道管理器配置

```c
struct wdcm_cfg {
    int channel_state;   // WIRED_CHANNEL_CUTOFF / RESTORE
    int force_flag;      // WDCM_FORCED / UNFORCED
};

struct wdcm_client_info {
    int state;           // 当前状态
    bool force_flag;     // 是否强制
};
```

### 3.3 OVP Switch GPIO 参数

```c
struct ovp_chsw_gpio_para {
    int gpio_count;                          // GPIO 数量
    int gpio_num[WIRED_CHANNEL_ALL];         // GPIO 编号数组
    int gpio_restraint[WIRED_CHANNEL_ALL];   // 约束关系（依赖其他通道）
    int gpio_path[WIRED_CHANNEL_ALL];        // GPIO 对应的通道类型
    int gpio_en_status[WIRED_CHANNEL_ALL];   // 使能状态（高/低有效）
    unsigned int gpio_status[WIRED_CHANNEL_ALL]; // 当前状态
};
```

## 4. 三层实现详解

### 4.1 抽象接口层（wired_channel_switch.c）

**职责：** 提供统一的通道切换接口，路由到具体实现

#### 4.1.1 核心 API

```c
// 设置指定通道状态
int wired_chsw_set_wired_channel(int channel_type, int state)
{
    // 1. 检查 ops 是否注册
    if (!g_chsw_ops || !g_chsw_ops->set_wired_channel)
        return 0;
    
    // 2. 无线发射联动处理
    wltx_vbus_change_type = wltx_get_vbus_change_type();
    if (wltx_vbus_change_type == WLTX_VBUS_CHANGED_BY_WIRED_CHSW) {
        if (state == WIRED_CHANNEL_RESTORE)
            wireless_tx_cancel_work(PWR_SW_BY_VBUS_ON);
        else if (all_other_channels_cutoff)
            wireless_tx_cancel_work(PWR_SW_BY_VBUS_OFF);
    }
    
    // 3. 调用实现层接口
    g_chsw_ops->set_wired_channel(channel_type, state);
    
    // 4. 无线发射重启检查
    if (state == WIRED_CHANNEL_RESTORE)
        wireless_tx_restart_check(PWR_SW_BY_VBUS_ON);
    else if (all_channels_cutoff)
        wireless_tx_restart_check(PWR_SW_BY_VBUS_OFF);
    
    return 0;
}
```

**关键特性：**
- 📡 **无线发射联动**：VBUS 变化时自动取消/重启无线发射
- 🔄 **状态查询**：设置后回读确认
- 📝 **详细日志**：记录每次切换操作

#### 4.1.2 设置其他通道

```c
int wired_chsw_set_other_wired_channel(int channel_type, int state)
{
    // 设置除指定通道外的所有其他通道
    // 典型用例：打开 SC 通道时，关闭 BUCK、LVC 等其他通道
    return g_chsw_ops->set_other_wired_channel(channel_type, state);
}
```

### 4.2 投票管理层（wired_channel_manager.c）

**职责：** 管理多个客户端对 BUCK 通道的投票，仲裁最终状态

#### 4.2.1 投票机制

```c
static int wdcm_vote_buck_channel_state(struct wdcm_dev *l_dev)
{
    // 优先级 1：强制状态（最高优先级）
    for (client = WDCM_CLIENT_BEGIN; client < WDCM_CLIENT_END; client++) {
        if (l_dev->client_info[client].force_flag)
            return l_dev->client_info[client].state;
    }
    
    // 优先级 2：任意 CUTOFF 投票（次高优先级）
    for (client = WDCM_CLIENT_BEGIN; client < WDCM_CLIENT_END; client++) {
        if (l_dev->client_info[client].state == WIRED_CHANNEL_CUTOFF)
            return WIRED_CHANNEL_CUTOFF;
    }
    
    // 默认：全部投 RESTORE 时才恢复
    return WIRED_CHANNEL_RESTORE;
}
```

**投票规则：**
1. **强制模式优先**：有 force_flag 的客户端直接决定结果
2. **CUTOFF 优先**：任意客户端要求关闭则关闭（安全优先）
3. **全 RESTORE**：所有客户端都同意才恢复

#### 4.2.2 客户端状态设置

```c
void wdcm_set_buck_channel_state(int client, int client_state)
{
    // 1. 根据配置表获取通道状态和强制标志
    l_dev->client_info[client].state = 
        g_wdcm_ctrl[client].wdcm_cfg[client_state].channel_state;
    l_dev->client_info[client].force_flag = 
        g_wdcm_ctrl[client].wdcm_cfg[client_state].force_flag;
    
    // 2. 投票决策
    if (l_dev->client_info[client].force_flag)
        voted_state = l_dev->client_info[client].state;  // 强制模式
    else
        voted_state = wdcm_vote_buck_channel_state(l_dev); // 正常投票
    
    // 3. 执行切换
    wired_chsw_set_wired_channel(WIRED_CHANNEL_BUCK, voted_state);
}
```

**配置示例（DTS）：**

```dts
wired_channel_manager {
    compatible = "huawei,wired_channel_manager";
    
    /* 有线充电：ON 时 RESTORE + 强制，OFF 时 RESTORE + 普通 */
    wdcm_wired_on_para = <0 1>;    // state=0(RESTORE), force=1
    wdcm_wired_off_para = <0 0>;   // state=0(RESTORE), force=0
    
    /* OTG：ON 时 CUTOFF，OFF 时 RESTORE */
    wdcm_otg_on_para = <1 0>;      // state=1(CUTOFF), force=0
    wdcm_otg_off_para = <0 0>;     // state=0(RESTORE), force=0
    
    /* 低功耗模式：ON 时 CUTOFF，OFF 时 RESTORE */
    wdcm_lpm_on_para = <1 0>;
    wdcm_lpm_off_para = <0 0>;
};
```

### 4.3 实现层

#### 4.3.1 OVP Switch（ovp_switch.c）

**原理：** 通过 GPIO 控制 OVP（过压保护）芯片的开关

**硬件拓扑：**

```
VBUS ──┬──[OVP_BUCK]───► BUCK 充电IC
       │
       ├──[OVP_LVC]────► LVC 直充IC
       │
       ├──[OVP_SC]─────► SC 直充IC
       │
       └──[OVP_SC4]────► SC4 直充IC

每个 OVP 由独立 GPIO 控制：
  GPIO=1 → 通道关闭（CUTOFF）
  GPIO=0 → 通道开启（RESTORE）
```

**GPIO 约束机制：**

```c
struct ovp_chsw_gpio_para {
    int gpio_restraint[WIRED_CHANNEL_ALL];  // 约束关系数组
};

// DTS 配置示例
gpio_types = "buck_gpio_en", "lvc_gpio_en", "sc_gpio_en";
gpio_restraints = "na", "buck_gpio_en", "buck_gpio_en";
// 含义：LVC 和 SC 都依赖 BUCK 通道，不能单独关闭 BUCK
```

**约束处理逻辑：**

```c
static int ovp_chsw_configure_gpio_status(int index, unsigned int value)
{
    // 检查约束：如果要关闭当前通道，检查是否有其他通道依赖它
    if ((para->gpio_restraint[index] >= 0) && (value == WIRED_CHANNEL_CUTOFF)) {
        // 如果依赖通道还在使用，拒绝关闭
        if (ovp_chsw_get_wired_channel(para->gpio_restraint[index]) != CUTOFF) {
            hwlog_info("set %d cutoff fail, because %d need it\n", ...);
            return 0;
        }
    }
    
    // 设置 GPIO 状态
    if (gpio_low_by_set_input && (value == WIRED_CHANNEL_RESTORE))
        gpio_direction_input(gpio);    // 高阻态恢复
    else
        gpio_direction_output(gpio, value);
    
    return 0;
}
```

**关键特性：**
- 🔒 **约束保护**：防止关闭被依赖的通道
- 🔄 **灵活配置**：支持高有效/低有效 GPIO
- 🎛️ **高阻模式**：通过设置 GPIO 为输入实现高阻恢复

#### 4.3.2 NCP3902 Switch（ncp3902_switch.c）

**原理：** 通过 NCP3902 芯片控制 BUCK 通道和反向充电通道

**硬件拓扑：**

```
                    ┌─────────────┐
VBUS ───► [NCP3902]─┤ EN   FLAG_N ├─► Charger IC
                    └─────────────┘
                      │     │
                 GPIO_EN  GPIO_FLAG_N
```

**控制逻辑：**

```c
// EN 控制 BUCK 通道
static int ncp3902_chsw_set_wired_channel(int channel_type, int flag)
{
    // flag=CUTOFF → GPIO=1 (关闭)
    // flag=RESTORE → GPIO=0 (开启)
    gpio_val = (flag == WIRED_CHANNEL_CUTOFF) ? 1 : 0;
    gpio_set_value(g_ncp3902_chsw_en, gpio_val);
    
    return 0;
}

// FLAG_N 控制反向充电通道（MOS 开关）
static int ncp3902_chsw_set_wired_reverse_channel(int flag)
{
    // 1. 先设置 BUCK 通道状态
    wired_channel_flag = (flag == WIRED_REVERSE_CHANNEL_CUTOFF) ?
        WIRED_CHANNEL_CUTOFF : WIRED_CHANNEL_RESTORE;
    ncp3902_chsw_set_wired_channel(WIRED_CHANNEL_BUCK, wired_channel_flag);
    
    // 2. 控制 FLAG_N（反向逻辑）
    // flag=CUTOFF → GPIO=0 (MOS 关闭)
    // flag=RESTORE → GPIO=1 (MOS 开启)
    gpio_val = (flag == WIRED_REVERSE_CHANNEL_CUTOFF) ? 0 : 1;
    gpio_set_value(g_ncp3902_chsw_flag_n, gpio_val);
    
    return 0;
}
```

**应用场景：**
- 🔌 仅支持 BUCK 通道控制
- 🔄 支持反向充电通道（无线充电器供电给手机）
- 💡 简化版实现，适用于单通道产品

## 5. 核心流程实现

### 5.1 通道切换完整流程

```
┌─────────────────────────────────────────────────────┐
│ 1. 应用层调用                                        │
│    wired_chsw_set_wired_channel(WIRED_CHANNEL_SC,  │
│                                  WIRED_CHANNEL_RESTORE) │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│ 2. 抽象接口层处理                                    │
│    • 检查 ops 注册                                  │
│    • 无线发射预处理（取消 wireless_tx）              │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│ 3. 实现层执行（OVP Switch）                          │
│    • 检查通道是否已经是目标状态                       │
│    • 查找 SC 对应的 GPIO 索引                        │
│    • 检查 GPIO 约束（是否有通道依赖它）               │
│    • 设置 GPIO 电平                                 │
│    • 更新内部状态                                   │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│ 4. 抽象接口层后处理                                  │
│    • 回读通道状态确认                                │
│    • 无线发射重启检查（wireless_tx_restart_check）   │
│    • 记录日志                                       │
└─────────────────────────────────────────────────────┘
```

### 5.2 多客户端投票流程

**场景：** OTG 启动时需要关闭 BUCK 通道

```c
// 1. OTG 请求关闭 BUCK
wdcm_set_buck_channel_state(WDCM_CLIENT_OTG, WDCM_DEV_ON);
  ↓
// 2. 查表获取配置
g_wdcm_ctrl[WDCM_CLIENT_OTG].wdcm_cfg[WDCM_DEV_ON] = {
    .channel_state = WIRED_CHANNEL_CUTOFF,
    .force_flag = WDCM_UNFORCED
}
  ↓
// 3. 更新客户端信息
l_dev->client_info[WDCM_CLIENT_OTG].state = CUTOFF
l_dev->client_info[WDCM_CLIENT_OTG].force_flag = false
  ↓
// 4. 投票决策
wdcm_vote_buck_channel_state():
  - 无强制标志的客户端
  - 发现 OTG 投了 CUTOFF
  - 返回 CUTOFF（任意 CUTOFF 优先）
  ↓
// 5. 执行切换
wired_chsw_set_wired_channel(WIRED_CHANNEL_BUCK, WIRED_CHANNEL_CUTOFF)
```

**投票表格示例：**

| 时刻 | WIRED | OTG | WLS | LPM | 投票结果 | 说明 |
|-----|-------|-----|-----|-----|---------|------|
| T0 | RESTORE(F) | RESTORE | CUTOFF | RESTORE | RESTORE | WIRED 强制 |
| T1 | RESTORE | CUTOFF | CUTOFF | RESTORE | CUTOFF | OTG 投 CUTOFF |
| T2 | RESTORE(F) | CUTOFF | CUTOFF | RESTORE | RESTORE | WIRED 强制优先 |

**(F) 表示 force_flag=true**

### 5.3 设置其他通道流程

**场景：** 打开 SC 通道时，需要关闭其他所有通道

```c
// 1. 设置 SC 通道为 RESTORE
wired_chsw_set_wired_channel(WIRED_CHANNEL_SC, WIRED_CHANNEL_RESTORE);
  ↓
// 2. 关闭其他通道
wired_chsw_set_other_wired_channel(WIRED_CHANNEL_SC, WIRED_CHANNEL_CUTOFF);
  ↓
// 3. OVP Switch 实现层处理
for (i = 0; i < gpio_count; i++) {
    // 跳过 SC 通道本身
    if (para->gpio_path[i] == WIRED_CHANNEL_SC)
        continue;
    
    // 跳过有约束的通道（如果 SC 依赖它）
    if (para->gpio_restraint[i] >= 0)
        continue;
    
    // 关闭其他通道（BUCK、LVC 等）
    ovp_chsw_configure_gpio_status(i, WIRED_CHANNEL_CUTOFF);
}
```

**时序图：**

```
BUCK: ████████████████████▓▓▓▓░░░░░░░░░░░░░░░░ (关闭)
LVC:  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ (保持关闭)
SC:   ░░░░░░░░░░░░░░░░░░░░████████████████████ (打开)
      │                   │
      T0                  T1 (设置其他通道)
```

## 6. 典型使用场景

### 6.1 无线充电启动

```c
// 无线充电启动时关闭所有有线通道
void wireless_charge_start(void)
{
    // 关闭所有有线通道，防止同时充电
    wired_chsw_set_wired_channel(WIRED_CHANNEL_ALL, WIRED_CHANNEL_CUTOFF);
}
```

**日志输出：**
```
[wireless_rx] wired_channel_all need set off
[ovp_chsw] buck switch set off
[ovp_chsw] lvc switch set off
[ovp_chsw] sc switch set off
```

### 6.2 直充模式切换

```c
// 进入 SC 直充模式
void enter_sc_direct_charge(void)
{
    // 1. 打开 SC 通道
    wired_chsw_set_wired_channel(WIRED_CHANNEL_SC, WIRED_CHANNEL_RESTORE);
    
    // 2. 关闭其他通道（BUCK、LVC）
    wired_chsw_set_other_wired_channel(WIRED_CHANNEL_SC, WIRED_CHANNEL_CUTOFF);
}
```

**硬件状态变化：**
```
BUCK: ON → OFF
LVC:  OFF (保持)
SC:   OFF → ON
```

### 6.3 OTG 启动

```c
// OTG 启动时关闭 BUCK 充电
void otg_enable(void)
{
    if (wdcm_dev_exist()) {
        // 使用 WDCM 管理器投票
        wdcm_set_buck_channel_state(WDCM_CLIENT_OTG, WDCM_DEV_ON);
    } else {
        // 直接控制
        wired_chsw_set_wired_channel(WIRED_CHANNEL_ALL, WIRED_CHANNEL_CUTOFF);
    }
}

// OTG 关闭时恢复 BUCK
void otg_disable(void)
{
    if (wdcm_dev_exist()) {
        wdcm_set_buck_channel_state(WDCM_CLIENT_OTG, WDCM_DEV_OFF);
    } else {
        struct wired_chsw_dts *dts = wired_chsw_get_dts();
        if (dts && dts->wired_sw_dflt_on)
            wired_chsw_set_wired_channel(WIRED_CHANNEL_BUCK, WIRED_CHANNEL_RESTORE);
    }
}
```

### 6.4 低功耗模式

```c
// 进入低功耗模式时关闭充电通道
void enter_low_power_mode(void)
{
    wdcm_set_buck_channel_state(WDCM_CLIENT_LPM, WDCM_DEV_ON);
}

// 退出低功耗模式
void exit_low_power_mode(void)
{
    wdcm_set_buck_channel_state(WDCM_CLIENT_LPM, WDCM_DEV_OFF);
}
```

### 6.5 无线反向充电

```c
// 启动无线发射（手机给其他设备充电）
void wireless_tx_enable(void)
{
    if (wdcm_dev_exist()) {
        // 关闭 BUCK 通道，防止同时充电
        wdcm_set_buck_channel_state(WDCM_CLIENT_TX_OTG, WDCM_DEV_ON);
    }
}

// 停止无线发射
void wireless_tx_disable(void)
{
    if (wdcm_dev_exist()) {
        wdcm_set_buck_channel_state(WDCM_CLIENT_TX_OTG, WDCM_DEV_OFF);
    }
}
```

## 7. 设计模式与优化

### 7.1 策略模式（Strategy Pattern）

**抽象策略：** `struct wired_chsw_device_ops`

```c
struct wired_chsw_device_ops {
    int (*set_wired_channel)(int channel_type, int state);
    int (*set_other_wired_channel)(int channel_type, int state);
    int (*get_wired_channel)(int channel_type);
    int (*set_wired_reverse_channel)(int state);
};
```

**具体策略：**
- `ovp_chsw_ops` - OVP GPIO 控制策略（多通道）
- `ncp3902_chsw_ops` - NCP3902 芯片控制策略（单通道）
- `mixed_ovp_chsw_ops` - 混合 OVP 控制策略

**上下文：** `g_chsw_ops` 全局指针

### 7.2 投票仲裁机制

**设计思想：** 多个客户端共享资源（BUCK 通道），通过投票决定最终状态

**优先级设计：**
1. **强制模式** > **普通模式**
2. **CUTOFF** > **RESTORE**（安全优先）

```c
// 强制模式示例：有线充电正在进行
client_info[WDCM_CLIENT_WIRED] = {
    .state = RESTORE,
    .force_flag = true  // 强制开启，其他客户端无法关闭
};

// 安全优先示例：OTG 和有线同时请求
client_info[WDCM_CLIENT_OTG].state = CUTOFF;    // 要求关闭
client_info[WDCM_CLIENT_WIRED].state = RESTORE; // 要求开启
// 结果：CUTOFF（安全优先，防止 OTG 和充电同时进行）
```

### 7.3 约束依赖管理

**问题：** 多个充电路径可能共享硬件资源，存在依赖关系

**解决方案：** 通过 `gpio_restraint` 数组表达依赖关系

```c
// DTS 配置
gpio_types = "buck_gpio_en", "lvc_gpio_en", "sc_gpio_en";
gpio_restraints = "na", "buck_gpio_en", "buck_gpio_en";
//                └─┬─┘  └──────┬──────┘  └──────┬──────┘
//                  │           │                 │
//               BUCK 无依赖    LVC 依赖 BUCK    SC 依赖 BUCK

// 含义：
// - BUCK 可以独立关闭
// - 关闭 BUCK 前必须先关闭 LVC 和 SC
// - LVC 和 SC 不能单独存在，必须有 BUCK
```

**运行时检查：**

```c
if ((para->gpio_restraint[index] >= 0) && (value == WIRED_CHANNEL_CUTOFF)) {
    // 检查依赖通道是否还在使用
    if (ovp_chsw_get_wired_channel(para->gpio_restraint[index]) == RESTORE) {
        // 依赖通道还在使用，拒绝关闭
        hwlog_info("set %d cutoff fail, because %d need it\n", ...);
        return 0;
    }
}
```

### 7.4 无线发射联动机制

**问题：** VBUS 状态变化时，无线发射功能需要同步调整

**解决方案：** 在通道切换前后插入无线发射控制

```c
int wired_chsw_set_wired_channel(int channel_type, int state)
{
    // 前处理：VBUS 变化前取消无线发射
    if (state == WIRED_CHANNEL_RESTORE)
        wireless_tx_cancel_work(PWR_SW_BY_VBUS_ON);
    else if (all_other_channels_cutoff)
        wireless_tx_cancel_work(PWR_SW_BY_VBUS_OFF);
    
    // 执行通道切换
    g_chsw_ops->set_wired_channel(channel_type, state);
    
    // 后处理：VBUS 稳定后重启无线发射检查
    if (state == WIRED_CHANNEL_RESTORE)
        wireless_tx_restart_check(PWR_SW_BY_VBUS_ON);
    else if (all_channels_cutoff)
        wireless_tx_restart_check(PWR_SW_BY_VBUS_OFF);
    
    return 0;
}
```

### 7.5 GPIO 高阻模式优化

**问题：** 某些平台 GPIO 输出低电平时可能有漏电

**解决方案：** 使用 GPIO 输入模式（高阻态）代替输出低电平

```c
if (gpio_low_by_set_input && (value == WIRED_CHANNEL_RESTORE))
    ret = gpio_direction_input(gpio);  // 高阻态，减少漏电
else
    ret = gpio_direction_output(gpio, value);
```

**DTS 配置：**
```dts
ovp_channel_switch {
    gpio_low_by_set_input = <1>;  // 1=使能高阻模式，0=使用普通输出
};
```

## 8. 调试方法

### 8.1 日志关键字

```bash
# 查看通道切换日志
dmesg | grep "wired_chsw\|ovp_chsw\|ncp3902_chsw"

# 查看投票管理日志
dmesg | grep "wdcm"

# 查看具体通道操作
dmesg | grep "buck\|lvc\|sc"
```

### 8.2 典型日志分析

**正常切换流程：**
```
[  100.123] wired_chsw: wired_channel_sc need set on
[  100.124] ovp_chsw: 2 switch set on           # SC 通道打开
[  100.125] wired_chsw: wired_channel_sc is set to on
[  100.126] wired_chsw: wired_channel_buck need set off
[  100.127] ovp_chsw: 0 switch set off          # BUCK 通道关闭
```

**约束冲突：**
```
[  105.123] ovp_chsw: set 0 cutoff fail, because 2 need it keep on
[  105.124] wired_chsw: attempt to close BUCK while SC is active
```

**投票仲裁：**
```
[  110.123] wdcm: [set_buck_channel] client:WDCM_CLIENT_OTG original_state off, voted_state off
[  110.124] wired_chsw: wired_channel_buck need set off
```

### 8.3 GPIO 状态检查

```bash
# 查看所有 GPIO 状态
cat /sys/kernel/debug/gpio

# 查看特定 GPIO（假设 BUCK 使用 GPIO 123）
cat /sys/class/gpio/gpio123/value
cat /sys/class/gpio/gpio123/direction
```

### 8.4 动态调试

**使能动态日志：**

```bash
# 使能所有 wired_channel_switch 日志
echo 'file wired_channel*.c +p' > /sys/kernel/debug/dynamic_debug/control

# 使能特定函数日志
echo 'func wired_chsw_set_wired_channel +p' > /sys/kernel/debug/dynamic_debug/control
echo 'func wdcm_vote_buck_channel_state +p' > /sys/kernel/debug/dynamic_debug/control
```

### 8.5 故障诊断流程

```
问题：充电通道切换失败
  ├─ 1. 检查 ops 是否注册
  │    └─ dmesg | grep "ops register"
  │
  ├─ 2. 检查 GPIO 配置
  │    ├─ cat /sys/kernel/debug/gpio
  │    └─ 验证 gpio_types 和 gpio_restraints 配置
  │
  ├─ 3. 检查投票状态（如果使用 WDCM）
  │    └─ dmesg | grep "voted_state"
  │
  ├─ 4. 检查约束关系
  │    └─ dmesg | grep "deponds on\|need it keep on"
  │
  └─ 5. 检查无线发射联动
       └─ dmesg | grep "wireless_tx"
```

## 9. DTS 配置示例

### 9.1 OVP Switch 配置

```dts
ovp_channel_switch {
    compatible = "huawei,ovp_channel_switch";
    status = "ok";
    
    /* GPIO 列表（按顺序对应 gpio_types）*/
    gpios = <&gpio10 1 0>,  /* BUCK: GPIO_10_1 */
            <&gpio11 2 0>,  /* LVC:  GPIO_11_2 */
            <&gpio12 3 0>;  /* SC:   GPIO_12_3 */
    
    /* GPIO 类型标签 */
    gpio_types = "buck_gpio_en",
                 "lvc_gpio_en",
                 "sc_gpio_en";
    
    /* GPIO 使能状态（0=低有效，1=高有效）*/
    gpio_en_status = <0>, <0>, <0>;
    
    /* GPIO 约束关系 */
    gpio_restraints = "na",              /* BUCK 无依赖 */
                      "buck_gpio_en",    /* LVC 依赖 BUCK */
                      "buck_gpio_en";    /* SC 依赖 BUCK */
    
    /* 使用高阻模式恢复 */
    gpio_low_by_set_input = <1>;
};
```

### 9.2 Wired Channel Manager 配置

```dts
wired_channel_manager {
    compatible = "huawei,wired_channel_manager";
    status = "ok";
    
    /* 无线充电客户端配置 */
    wdcm_wls_on_para = <1 0>;   /* ON: CUTOFF, 普通 */
    wdcm_wls_off_para = <1 0>;  /* OFF: CUTOFF, 普通 */
    
    /* 有线充电客户端配置（强制模式）*/
    wdcm_wired_on_para = <0 1>;  /* ON: RESTORE, 强制 */
    wdcm_wired_off_para = <0 0>; /* OFF: RESTORE, 普通 */
    
    /* OTG 客户端配置 */
    wdcm_otg_on_para = <1 0>;   /* ON: CUTOFF, 普通 */
    wdcm_otg_off_para = <0 0>;  /* OFF: RESTORE, 普通 */
    
    /* 无线发射 OTG 配置 */
    wdcm_tx_otg_on_para = <1 0>;
    wdcm_tx_otg_off_para = <0 0>;
    
    /* 低功耗模式配置 */
    wdcm_lpm_on_para = <1 0>;   /* ON: CUTOFF, 普通 */
    wdcm_lpm_off_para = <0 0>;  /* OFF: RESTORE, 普通 */
    
    /* 反向充电配置 */
    wdcm_tx_rvssc_on_para = <0 0>;
    wdcm_tx_rvssc_off_para = <0 0>;
};
```

### 9.3 Wired Channel Switch 配置

```dts
wired_channel_switch {
    compatible = "huawei,wired_channel_switch";
    status = "ok";
    
    /* 使用 OVP 控制有线通道 */
    use_ovp_cutoff_wired_channel = <1>;
    
    /* 默认开启有线开关 */
    wired_sw_dflt_on = <1>;
};
```

## 10. 总结

wired_channel_switch 模块是华为充电管理系统中的**充电路径仲裁中心**，通过以下设计实现了灵活、安全的多通道管理：

**核心特性：**
1. ✅ **三层架构**：抽象层 + 管理层 + 实现层，职责清晰
2. ✅ **投票机制**：多客户端协同决策，强制模式 > CUTOFF > RESTORE
3. ✅ **约束管理**：依赖关系保护，防止非法通道组合
4. ✅ **无线联动**：VBUS 变化时自动调整无线发射状态
5. ✅ **灵活实现**：支持 OVP、NCP3902 等多种硬件方案

**应用价值：**
- 🔌 **互斥保护**：防止 BUCK/LVC/SC 等多路径同时开启
- 🛡️ **安全优先**：任意客户端要求关闭即关闭（OTG、低功耗等）
- 🎯 **集中管理**：统一接口简化上层调用
- 🔄 **动态切换**：无缝切换充电模式（普通充电 ↔ 快充 ↔ 超级快充）

**典型应用场景：**
- 📱 无线充电启动 → 关闭所有有线通道
- ⚡ 进入直充模式 → 打开 SC/LVC，关闭 BUCK
- 🔌 OTG 启动 → 关闭 BUCK 充电通道
- 💤 低功耗模式 → 关闭充电，降低功耗

该模块充分体现了**策略模式**和**投票仲裁机制**的设计思想，是多充电路径产品的核心管理组件。