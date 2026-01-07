---
outline: deep
---

# VBUS Channel 模块分析

## 1. 模块定位与核心价值

vbus_channel 是华为充电管理系统中的 **VBUS 通道抽象层**，负责管理和切换不同的 VBUS 输出通道。它是一个典型的**策略模式实现**，为多种 OTG 和无线反向充电场景提供统一的 VBUS 管理接口。

**核心价值：**
- 🔄 **多通道抽象**：统一管理 Charger、Boost GPIO、Pogopin Boost 三种 VBUS 输出方式
- 👥 **多用户支持**：支持 6 种用户场景（有线 OTG、无线发射、直充、PD、音频、触点）
- 🛡️ **故障保护**：集成 OTG 短路保护（SCP）和过流保护（OCP）机制
- 🎯 **路由分发**：根据用户类型和通道类型智能路由到对应实现

## 2. 系统架构

### 2.1 三层架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    用户层 (6 种用户场景)                      │
├─────────────────────────────────────────────────────────────┤
│  WIRED_OTG │ WR_TX │ DC │ PD │ AUDIO │ POGOPIN              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              vbus_channel.c (抽象路由层)                      │
├─────────────────────────────────────────────────────────────┤
│ • vbus_ch_open()         • vbus_ch_get_state()              │
│ • vbus_ch_close()        • vbus_ch_set_voltage()            │
│ • vbus_ch_get_mode()     • vbus_ch_ops_register()           │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
┌───────────┐  ┌──────────────┐  ┌──────────────────┐
│  CHARGER  │  │  BOOST_GPIO  │  │  POGOPIN_BOOST   │
│   实现层   │  │    实现层     │  │      实现层       │
├───────────┤  ├──────────────┤  ├──────────────────┤
│ Charger   │  │ GPIO + 5V    │  │ Pogopin +        │
│ IC OTG    │  │ Boost IC     │  │ BuckBoost        │
└───────────┘  └──────────────┘  └──────────────────┘
        │              │              │
        └──────────────┼──────────────┘
                       ▼
        ┌──────────────────────────────┐
        │   vbus_channel_error_handle  │
        │   (错误处理层)                 │
        ├──────────────────────────────┤
        │ • OTG SCP 检测               │
        │ • OTG OCP 检测               │
        │ • DMD 故障上报               │
        └──────────────────────────────┘
```

### 2.2 用户-通道类型矩阵

| 用户类型 | CHARGER | BOOST_GPIO | POGOPIN_BOOST | 典型场景 |
|---------|---------|------------|---------------|----------|
| WIRED_OTG | ✓ | ✓ | ✓ | 有线 OTG 外设供电 |
| WR_TX | ✓ | ✓ | - | 无线反向充电 |
| DC | ✓ | - | - | 直充模式 VBUS 控制 |
| PD | ✓ | ✓ | ✓ | PD 协议 OTG 场景 |
| AUDIO | ✓ | - | - | 音频配件供电 |
| POGOPIN | - | - | ✓ | 触点连接器供电 |

## 3. 核心数据结构

### 3.1 VBUS 通道操作结构

```c
struct vbus_ch_ops {
    const char *type_name;                                 // "charger" / "boost_gpio" / "pogopin_boost"
    int (*open)(unsigned int user, int flag);              // 打开通道
    int (*close)(unsigned int user, int flag, int force);  // 关闭通道
    int (*get_state)(unsigned int user, int *state);       // 获取状态
    int (*get_mode)(unsigned int user, int *mode);         // 获取模式
    int (*set_switch_mode)(unsigned int user, int mode);   // 设置切换模式
    int (*set_voltage)(unsigned int user, int vol);        // 设置电压
    int (*get_voltage)(unsigned int user, int *vol);       // 获取电压
};
```

### 3.2 VBUS 通道设备结构

```c
struct vbus_ch_dev {
    unsigned int total_ops;                    // 已注册的 ops 数量
    struct vbus_ch_ops *ops[VBUS_CH_TYPE_END]; // ops 数组 (最多3个)
};
```

### 3.3 错误处理参数

```c
// OTG 短路检查参数
struct otg_scp_para {
    unsigned int vol_mv;         // 电压阈值 (默认 3400mV)
    unsigned int check_times;    // 检查次数 (默认 30 次)
    unsigned int delayed_time;   // 延迟时间 (默认 300ms)
    unsigned int fault_count;    // 故障计数器
    bool work_flag;              // 工作标志
    struct delayed_work work;    // 延迟工作队列
};

// OTG 过流检查参数
struct otg_ocp_para {
    unsigned int vol_mv;         // 电压阈值 (默认 4300mV)
    unsigned int check_times;    // 检查次数 (默认 3 次)
    unsigned int delayed_time;   // 延迟时间 (默认 1000ms)
    unsigned int fault_count;    // 故障计数器
    bool work_flag;              // 工作标志
    struct delayed_work work;    // 延迟工作队列
};
```

## 4. 三种实现详解

### 4.1 CHARGER 实现（vbus_channel_charger）

**原理：** 通过 Charger IC 的 OTG 功能输出 5V

**关键流程：**

```c
static int charger_otg_start_config(int flag)
{
    // 1. 获取唤醒锁，防止休眠
    power_wakeup_lock(l_dev->otg_lock, false);
    
    // 2. 关闭充电功能
    charger_otg_set_charger_enable(l_dev, false);
    
    // 3. 使能 OTG 输出
    charger_otg_set_otg_enable(l_dev, true);
    
    // 4. 设置 OTG 电流限制 (默认 1000mA)
    charger_otg_set_otg_current(l_dev, l_dev->otg_curr);
    
    // 5. 启动看门狗喂狗任务
    schedule_delayed_work(&l_dev->otg_work, msecs_to_jiffies(0));
    
    return 0;
}
```

**看门狗机制：** 每 25 秒触发一次喂狗，防止 Charger IC 看门狗超时

```c
#define CHARGER_OTG_WORK_TIME      25000  // 25秒

static void charger_otg_work(struct work_struct *work)
{
    charger_otg_set_otg_enable(l_dev, true);       // 重新使能 OTG
    charger_otg_kick_watchdog(l_dev, true);        // 喂狗
    schedule_delayed_work(&l_dev->otg_work,        // 继续调度
        msecs_to_jiffies(CHARGER_OTG_WORK_TIME));
}
```

**支持的 Charger IC：**
- bq2419x, bq2429x, bq2560x, bq25882, bq25892
- hl7019, rt9466, rt9471
- hi6522, hi6523, hi6526
- bd99954, bq25713, schargerv700

### 4.2 BOOST_GPIO 实现（vbus_channel_boost_gpio）

**原理：** 通过 GPIO 控制外部 5V Boost IC 输出

**硬件控制序列：**

```c
static int boost_gpio_start_config(int flag)
{
    // 1. 设置无线充电功率限制源
    wlrx_plim_set_src(WLTRX_DRV_MAIN, WLRX_PLIM_SRC_OTG);
    
    // 2. 断开 BUCK 充电通道
    boost_gpio_start_config_wired_channel_control();
    
    // 3. 取消无线发射任务
    wireless_tx_cancel_work(PWR_SW_BY_OTG_ON);
    
    // 4. 等待硬件稳定
    msleep(100);
    
    // 5. 使能 5V Boost IC
    boost_5v_enable(BOOST_5V_ENABLE, BOOST_CTRL_BOOST_GPIO_OTG);
    power_usleep(DT_USLEEP_10MS);
    
    // 6. 拉高 GPIO 切换开关
    gpio_set_value(l_dev->gpio_en, BOOST_GPIO_SWITCH_ENABLE);
    
    // 7. 重启无线发射检查
    wireless_tx_restart_check(PWR_SW_BY_OTG_ON);
    
    return 0;
}
```

**硬件问题修复：** 某些平台存在漏电问题，需要同时打开 Charger OTG

```c
if (l_dev->charge_otg_ctl_flag) {
    vbus_ch_open(VBUS_CH_USER_WIRED_OTG, VBUS_CH_TYPE_CHARGER, false);
    // 200ms 后自动关闭
    schedule_delayed_work(&l_dev->charge_otg_close_work,
        msecs_to_jiffies(200));
}
```

**过流保护：** 支持 GPIO 中断检测 OCP

```c
static irqreturn_t boost_gpio_otg_ocp_irq_handler(int irq, void *_l_dev)
{
    schedule_work(&l_dev->otg_ocp_work);  // 触发保护处理
    return IRQ_HANDLED;
}
```

### 4.3 POGOPIN_BOOST 实现（vbus_channel_pogopin_boost）

**原理：** 通过 Pogopin 触点连接器输出，使用 BuckBoost IC

**硬件拓扑：**

```
Charger IC ──[MOS]── BuckBoost ──[Pogopin]── 外部设备
                          ↑
                     [OTG_EN GPIO]
```

**启动序列：**

```c
static int pogopin_boost_start_config(void)
{
    // 1. 打开 Charger 到 BuckBoost 的 MOS 开关
    gpio_set_value(l_dev->mos_en, MOS_GPIO_SWITCH_ENABLE);
    
    // 2. 故障检查（SCP/OCP）
    if (pogopin_boost_get_fault_status(l_dev))
        return 0;
    
    // 3. 硬件问题修复：打开 Charger OTG（如果需要）
    if (l_dev->charge_otg_ctl && charge_get_charger_type() == CHARGER_REMOVED) {
        vbus_ch_open(VBUS_CH_USER_WIRED_OTG, VBUS_CH_TYPE_CHARGER, false);
    }
    
    // 4. 使能 BuckBoost
    pogopin_boost_5v_enable(l_dev, BOOST_5V_ENABLE);
    
    // 5. 使能 OTG 控制 GPIO
    if (l_dev->otg_en_flag)
        gpio_set_value(l_dev->otg_en, OTG_GPIO_SWITCH_ENABLE);
    
    return 0;
}
```

**关闭序列：** 反向操作，并增加 160ms 延迟确保 BuckBoost 完全关闭

```c
static int pogopin_boost_stop_config(void)
{
    // 关闭 OTG 控制
    gpio_set_value(l_dev->otg_en, OTG_GPIO_SWITCH_DISABLE);
    
    // 关闭 BuckBoost
    pogopin_boost_5v_enable(l_dev, BOOST_5V_DISABLE);
    
    // 等待 BuckBoost 完全关闭（关键！）
    msleep(160);
    
    // 断开 MOS 开关
    gpio_set_value(l_dev->mos_en, MOS_GPIO_SWITCH_DISABLE);
    
    return 0;
}
```

## 5. 核心流程实现

### 5.1 打开 VBUS 通道流程

```c
int vbus_ch_open(unsigned int user, unsigned int type, int flag)
{
    struct vbus_ch_dev *l_dev = vbus_ch_get_dev();
    
    // 1. 参数合法性检查
    if (user >= VBUS_CH_USER_END || type >= VBUS_CH_TYPE_END)
        return -EPERM;
    
    // 2. 验证 ops 是否已注册
    if (!l_dev->ops[type] || !l_dev->ops[type]->open)
        return -EPERM;
    
    // 3. 调用具体实现的 open 方法
    return l_dev->ops[type]->open(user, flag);
}
```

**用户位掩码管理：** 每个实现维护一个用户位图

```c
l_dev->user |= (1 << user);  // 打开时设置对应 bit
```

### 5.2 关闭 VBUS 通道流程

```c
int vbus_ch_close(unsigned int user, unsigned int type, int flag, int force)
{
    struct vbus_ch_dev *l_dev = vbus_ch_get_dev();
    
    if (force) {
        // 强制关闭：立即断开，不管其他用户
        return l_dev->ops[type]->close(user, flag, force);
    }
    
    // 正常关闭：清除用户 bit
    l_dev->user &= (~(unsigned int)(1 << user));
    
    // 只有所有用户都关闭时才真正断开硬件
    if (l_dev->user == VBUS_CH_NO_OP_USER) {
        return stop_config(flag);
    }
    
    return 0;
}
```

**引用计数管理：**
- 打开：`user |= (1 << user)`
- 关闭：`user &= (~(1 << user))`
- 判断：`if (user == VBUS_CH_NO_OP_USER)` 时真正关闭硬件

### 5.3 错误处理机制

#### 5.3.1 OTG 短路检测（SCP）

```c
static void otg_scp_check_work(struct work_struct *work)
{
    struct otg_scp_para *info = &l_dev->otg_scp;
    
    // 1. 检查 USB 状态（不在 OTG 模式则停止检查）
    if (vbus_ch_eh_check_usb_state(l_dev))
        return;
    
    // 2. 读取 VBUS 电压
    charge_get_vbus(&value);
    
    // 3. 判断是否低于阈值 (< 3400mV 表示短路)
    if (value < (int)info->vol_mv) {
        info->fault_count++;
    } else {
        info->fault_count = 0;
    }
    
    // 4. 超过故障次数阈值，触发保护
    if (info->fault_count > info->check_times) {
        l_dev->otg_scp_flag = true;
        power_event_bnc_notify(..., POWER_NE_HW_PD_SOURCE_VBUS, &vbus_enable);
        vbus_ch_eh_dmd_report(OTG_SCP_DMD_REPORT, &value);
        return;
    }
    
    // 5. 继续下一轮检测
    schedule_delayed_work(&info->work, msecs_to_jiffies(info->delayed_time));
}
```

**检测参数：**
- 电压阈值：3400mV（低于此值判定为短路）
- 检查次数：30 次
- 检查间隔：300ms
- 总检测时间：30 × 300ms = 9 秒

#### 5.3.2 OTG 过流检测（OCP）

**GPIO 中断方式：**

```c
static void boost_gpio_otg_ocp_work(struct work_struct *work)
{
    // 通知 PD 协议栈关闭 VBUS
    power_event_bnc_notify(POWER_BNT_OTG, POWER_NE_OTG_OCP_HANDLE, 
                          &l_dev->otg_ocp_int);
}

static irqreturn_t boost_gpio_otg_ocp_irq_handler(int irq, void *_l_dev)
{
    schedule_work(&l_dev->otg_ocp_work);
    return IRQ_HANDLED;
}
```

**轮询检测方式：**

```c
static void otg_ocp_check_work(struct work_struct *work)
{
    // 读取 VBUS 电压
    charge_get_vbus(&value);
    
    // 判断是否低于阈值 (< 4300mV 表示过流导致压降)
    if (value < (int)info->vol_mv) {
        info->fault_count++;
    } else {
        info->fault_count = 0;
    }
    
    // 超过 3 次触发保护
    if (info->fault_count > info->check_times) {
        power_event_bnc_notify(..., POWER_NE_HW_PD_SOURCE_VBUS, &vbus_enable);
        vbus_ch_eh_dmd_report(OTG_OCP_DMD_REPORT, &value);
        return;
    }
    
    schedule_delayed_work(&info->work, msecs_to_jiffies(info->delayed_time));
}
```

**检测参数：**
- 电压阈值：4300mV（过流时 VBUS 会压降）
- 检查次数：3 次
- 检查间隔：1000ms

#### 5.3.3 DMD 故障上报

```c
static void vbus_ch_eh_dmd_report(unsigned int err_no, int *val)
{
    char buf[VBUS_CH_EH_DMD_BUF_SIZE] = {0};
    
    snprintf(buf, sizeof(buf), "otg %s, vbus=%dmV\n",
        (err_no == OTG_SCP_DMD_REPORT) ? "scp" : "ocp",
        *val);
    
    power_dsm_report_dmd(POWER_DSM_BATTERY, err_no, buf);
}
```

## 6. 典型使用场景

### 6.1 有线 OTG 供电

```c
// 打开 OTG（使用 BOOST_GPIO 方式）
vbus_ch_open(VBUS_CH_USER_WIRED_OTG, VBUS_CH_TYPE_BOOST_GPIO, true);

// 关闭 OTG
vbus_ch_close(VBUS_CH_USER_WIRED_OTG, VBUS_CH_TYPE_BOOST_GPIO, true, false);
```

**硬件动作序列：**
1. 断开 BUCK 充电通道
2. 使能 5V Boost IC
3. 拉高 GPIO 切换到 OTG 输出
4. 启动 SCP/OCP 检测

### 6.2 无线反向充电

```c
// 打开无线发射（使用 CHARGER 方式）
vbus_ch_open(VBUS_CH_USER_WR_TX, VBUS_CH_TYPE_CHARGER, true);

// 关闭无线发射
vbus_ch_close(VBUS_CH_USER_WR_TX, VBUS_CH_TYPE_CHARGER, true, false);
```

**Charger OTG 模式：**
1. 关闭充电功能
2. 使能 Charger IC OTG
3. 设置电流限制（1000mA）
4. 启动看门狗喂狗任务

### 6.3 直充模式 VBUS 控制

```c
// 直充场景打开 VBUS（防止反灌）
vbus_ch_open(VBUS_CH_USER_DC, VBUS_CH_TYPE_CHARGER, false);

// 关闭 VBUS
vbus_ch_close(VBUS_CH_USER_DC, VBUS_CH_TYPE_CHARGER, false, false);
```

### 6.4 多用户并发场景

```c
// 用户 1 打开
vbus_ch_open(VBUS_CH_USER_WIRED_OTG, VBUS_CH_TYPE_BOOST_GPIO, true);
// user = 0x01

// 用户 2 打开（同一通道）
vbus_ch_open(VBUS_CH_USER_PD, VBUS_CH_TYPE_BOOST_GPIO, false);
// user = 0x11 (bit0 和 bit3 都置位)

// 用户 1 关闭
vbus_ch_close(VBUS_CH_USER_WIRED_OTG, VBUS_CH_TYPE_BOOST_GPIO, false, false);
// user = 0x10 (bit0 清除，但 bit3 仍保持)
// 硬件不关闭，因为还有用户在使用

// 用户 2 关闭
vbus_ch_close(VBUS_CH_USER_PD, VBUS_CH_TYPE_BOOST_GPIO, true, false);
// user = 0x00 (所有用户都关闭)
// 真正关闭硬件
```

## 7. 设计模式与优化

### 7.1 策略模式（Strategy Pattern）

**抽象策略：** `struct vbus_ch_ops`

```c
struct vbus_ch_ops {
    const char *type_name;
    int (*open)(unsigned int user, int flag);
    int (*close)(unsigned int user, int flag, int force);
    // ...
};
```

**具体策略：**
- `charger_otg_ops` - Charger IC 策略
- `boost_gpio_ops` - GPIO Boost 策略
- `pogopin_boost_ops` - Pogopin BuckBoost 策略

**上下文：** `struct vbus_ch_dev` 维护策略数组

### 7.2 注册-发现模式

```c
// 各实现模块注册自己的 ops
vbus_ch_ops_register(&boost_gpio_ops);      // 注册 BOOST_GPIO
vbus_ch_ops_register(&charger_otg_ops);     // 注册 CHARGER
vbus_ch_ops_register(&pogopin_boost_ops);   // 注册 POGOPIN_BOOST

// 用户调用时自动路由到对应实现
vbus_ch_open(user, VBUS_CH_TYPE_BOOST_GPIO, flag);  // 自动调用 boost_gpio_ops->open
```

### 7.3 引用计数管理

**位掩码设计：** 每个 user 对应一个 bit

```c
#define VBUS_CH_USER_WIRED_OTG  0  // bit 0
#define VBUS_CH_USER_WR_TX      1  // bit 1
#define VBUS_CH_USER_DC         2  // bit 2
#define VBUS_CH_USER_PD         3  // bit 3
#define VBUS_CH_USER_AUDIO      4  // bit 4
#define VBUS_CH_USER_POGOPIN    5  // bit 5

unsigned int user;  // 用户位图
```

**优点：**
- O(1) 时间复杂度的添加/删除操作
- 内存占用小（只需 4 字节）
- 支持最多 32 个用户

### 7.4 看门狗保活机制

**Charger IC 看门狗：** 防止 IC 超时自动关闭 OTG

```c
#define CHARGER_OTG_WORK_TIME      25000  // 每 25 秒喂狗一次

static void charger_otg_work(struct work_struct *work)
{
    charger_otg_set_otg_enable(l_dev, true);       // 重新使能
    charger_otg_kick_watchdog(l_dev, true);        // 喂狗
    schedule_delayed_work(&l_dev->otg_work, 
        msecs_to_jiffies(CHARGER_OTG_WORK_TIME));  // 继续调度
}
```

**系统看门狗：** 同时喂系统级看门狗

```c
power_platform_charge_feed_sys_wdt(CHARGER_OTG_SYS_WDT_TIMEOUT);
```

### 7.5 硬件缺陷规避设计

**问题 1：漏电问题**

```c
// 某些平台 Boost GPIO 单独使能会漏电
if (l_dev->charge_otg_ctl_flag) {
    vbus_ch_open(VBUS_CH_USER_WIRED_OTG, VBUS_CH_TYPE_CHARGER, false);
    schedule_delayed_work(&l_dev->charge_otg_close_work, 
        msecs_to_jiffies(200));  // 200ms 后自动关闭
}
```

**问题 2：关断时序问题**

```c
// Pogopin BuckBoost 需要等待 160ms 确保完全关闭
pogopin_boost_5v_enable(l_dev, BOOST_5V_DISABLE);
msleep(160);  // 关键延迟！
gpio_set_value(l_dev->mos_en, MOS_GPIO_SWITCH_DISABLE);
```

## 8. 调试方法

### 8.1 sysfs 接口

```bash
# 查看支持的用户类型
cat /sys/class/hw_power/vbus_channel/support_type
# 输出：wired_otg wr_tx dc pd audio pogopin
```

### 8.2 日志关键字

```bash
# 查看 VBUS 通道操作日志
dmesg | grep vbus_ch

# 查看错误处理日志
dmesg | grep "otg scp\|otg ocp"

# 查看具体实现日志
dmesg | grep "vbus_ch_boost_gpio\|vbus_ch_charger\|vbus_ch_pogopin"
```

### 8.3 典型日志分析

**正常打开流程：**
```
[  100.123] vbus_ch: user=1 type=1 open
[  100.124] vbus_ch_boost_gpio: start reverse_vbus flag=1
[  100.225] vbus_ch_boost_gpio: gpio_123 high now
[  100.226] vbus_ch_boost_gpio: user=1 open ok
```

**短路保护触发：**
```
[  105.123] vbus_ch_eh: otg scp check start
[  105.423] vbus_ch_eh: scp: value=3200, fault_count=1
[  105.723] vbus_ch_eh: scp: value=3150, fault_count=2
...
[  114.123] vbus_ch_eh: otg scp happen
[  114.124] DMD report: otg scp, vbus=3150mV
```

### 8.4 动态调试

**使能动态日志：**

```bash
# 使能所有 vbus_channel 日志
echo 'file vbus_channel*.c +p' > /sys/kernel/debug/dynamic_debug/control

# 查看特定函数日志
echo 'func vbus_ch_open +p' > /sys/kernel/debug/dynamic_debug/control
```

### 8.5 故障诊断流程

```
问题：OTG 不工作
  ├─ 1. 检查 ops 是否注册成功
  │    └─ dmesg | grep "ops register"
  │
  ├─ 2. 检查用户类型是否合法
  │    └─ cat /sys/class/hw_power/vbus_channel/support_type
  │
  ├─ 3. 检查是否触发保护
  │    ├─ dmesg | grep "otg scp"
  │    └─ dmesg | grep "otg ocp"
  │
  ├─ 4. 检查 GPIO 状态
  │    └─ cat /sys/kernel/debug/gpio
  │
  └─ 5. 检查 Charger IC 状态
       └─ cat /sys/class/power_supply/*/otg_enable
```

## 9. 总结

vbus_channel 模块是一个**典型的硬件抽象层实现**，通过以下设计达到了高度的灵活性和可扩展性：

**核心特性：**
1. ✅ **多通道支持**：CHARGER / BOOST_GPIO / POGOPIN_BOOST 三种实现
2. ✅ **多用户管理**：引用计数式的用户管理，支持并发访问
3. ✅ **完善保护**：SCP/OCP 双重保护，DMD 故障上报
4. ✅ **策略模式**：ops 注册机制，易于扩展新的实现
5. ✅ **硬件适配**：针对不同平台的硬件缺陷有专门的规避措施

**应用价值：**
- 🔌 统一的 VBUS 管理接口，屏蔽底层硬件差异
- 🛡️ 多层次的故障保护，提高 OTG 使用安全性
- 🔄 灵活的通道切换，支持多种充电和供电场景
- 📊 完整的日志和调试接口，便于问题定位

该模块充分体现了**面向对象设计在 C 语言中的实践**，是充电管理系统中硬件通道层的核心组件。