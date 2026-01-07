---
outline: deep
---

# charger_channel 模块分析

## 1. 模块定位与核心价值

`charger_channel` 是华为充电框架中的**充电通道切换模块**，负责在有线充电（USB）和无线充电（Wireless）两个硬件输入通道之间进行物理切换。该模块通过控制一个 GPIO 引脚来切换硬件多路复用器（MUX），实现单一充电路径的分时复用。

### 核心特性

- **硬件通道切换**：控制 GPIO 切换 USBIN/WLSIN 充电输入
- **极简设计**：仅 140 行代码，单一功能明确
- **全局可访问**：提供 `charger_select_channel()` 全局接口
- **互斥保护**：确保同一时刻只有一个充电源接入充电IC

### 应用背景

MATE X5 这类高端设备同时支持：
- **有线快充**：USB Type-C（SCP/FCP/PD/UFCS）
- **无线充电**：Qi 无线充电
- **反向无线充电**：手机给其他设备充电

由于硬件成本和布局限制，充电IC通常只有一个输入端口，因此需要通过硬件开关在有线和无线之间切换。

---

## 2. 系统架构

### 2.1 硬件拓扑图

```
                      ┌─────────────────────────────────────┐
                      │         充电管理系统                 │
                      │    (Charge Manager)                 │
                      └─────────────────────────────────────┘
                                     │
                                     │ charger_select_channel()
                                     ↓
┌───────────────────────────────────────────────────────────────────────┐
│                    charger_channel 模块                                │
│                   (充电通道切换控制)                                    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ charger_select_channel(int channel)                          │    │
│  │  ├─ CHARGER_CH_USBIN  (0) → GPIO = LOW                       │    │
│  │  └─ CHARGER_CH_WLSIN  (1) → GPIO = HIGH                      │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                         │
│                           ↓ GPIO 控制                                  │
│                    gpio_set_value(gpio_ch)                             │
└───────────────────────────────────────────────────────────────────────┘
                                     │
                                     ↓
                      ┌──────────────────────────────┐
                      │   硬件多路复用器 (MUX)        │
                      │                              │
                      │   GPIO=0: USB 通道           │
                      │   GPIO=1: 无线充电通道       │
                      └──────────────────────────────┘
                           │                 │
           ┌───────────────┘                 └───────────────┐
           ↓                                                 ↓
  ┌─────────────────┐                            ┌─────────────────┐
  │   USB Type-C    │                            │   无线充电线圈   │
  │   (USBIN)       │                            │   (WLSIN)       │
  │                 │                            │                 │
  │ • 有线快充      │                            │ • Qi 无线充电   │
  │ • OTG输入       │                            │ • 反向充电输入  │
  └─────────────────┘                            └─────────────────┘
                           │                 │
                           └────────┬────────┘
                                    ↓
                      ┌──────────────────────────────┐
                      │      充电 IC (Charger IC)     │
                      │   • Buck Charger             │
                      │   • Charge Pump              │
                      │   • Switch Capacitor         │
                      └──────────────────────────────┘
                                    ↓
                      ┌──────────────────────────────┐
                      │         电池组 (Battery)      │
                      └──────────────────────────────┘
```

### 2.2 软件调用关系

```
无线充电接收 (wireless_rx)
    ↓
wlrx_evt_rxic_notifier_call()
    ↓
charger_select_channel(CHARGER_CH_WLSIN)  ← 切换到无线通道
    ↓
充电IC从无线线圈接收功率

────────────────────────────────────────────────────

无线反向充电 (wireless_tx)
    ↓
wltx_set_otg_output(true)
    ↓
charger_select_channel(CHARGER_CH_WLSIN)  ← 切换到无线通道
    ↓
OTG 通过无线线圈输出功率

────────────────────────────────────────────────────

结束充电/恢复有线
    ↓
wltx_set_otg_output(false)
    ↓
charger_select_channel(CHARGER_CH_USBIN)  ← 恢复有线通道
    ↓
充电IC从USB接收功率
```

---

## 3. 核心数据结构

### 3.1 设备结构体

```c
struct charger_ch_dev {
    struct device *dev;       // 设备指针
    int gpio_ch;              // 通道切换 GPIO 编号
};
```

**字段说明**：
- `dev`: 指向 platform_device 的 device 结构
- `gpio_ch`: 从设备树解析的 GPIO 编号，控制 MUX 切换

### 3.2 通道定义

```c
/* 充电通道定义 */
#define CHARGER_CH_USBIN    0    // 有线充电通道 (USB Input)
#define CHARGER_CH_WLSIN    1    // 无线充电通道 (Wireless Input)
```

**硬件映射**：
```
通道值         GPIO电平        硬件通道
─────────────────────────────────────────
USBIN (0)  →   LOW (0)    →   USB Type-C
WLSIN (1)  →   HIGH (1)   →   无线充电线圈
```

---

## 4. 核心功能实现

### 4.1 通道切换接口

```c
void charger_select_channel(int channel)
{
    int gpio_val;
    struct charger_ch_dev *di = g_charger_ch_di;

    if (!di) {
        hwlog_err("charger_select_channel: di invalid\n");
        return;
    }

    // 根据通道选择GPIO电平
    if (channel == CHARGER_CH_USBIN)
        gpio_val = 0;           // USB通道: GPIO=LOW
    else if (channel == CHARGER_CH_WLSIN)
        gpio_val = 1;           // 无线通道: GPIO=HIGH
    else
        return;                 // 非法通道，不操作

    // 设置GPIO电平
    gpio_set_value(di->gpio_ch, gpio_val);
    
    // 打印日志确认切换结果
    hwlog_info("[select_channel] gpio %s now\n",
        gpio_get_value(di->gpio_ch) ? "high" : "low");
}
```

**功能说明**：
1. 检查设备是否初始化
2. 将通道枚举值转换为 GPIO 电平（0/1）
3. 通过 `gpio_set_value()` 控制硬件 MUX
4. 读取并打印当前 GPIO 状态验证切换成功

**关键点**：
- ✅ 无锁设计，简单快速
- ✅ 参数校验，防止非法通道
- ✅ 日志记录，便于调试追踪
- ⚠️ 无互斥保护，依赖上层调用者协调

### 4.2 GPIO 初始化

```c
static int charger_channel_gpio_init(struct device_node *np, struct charger_ch_dev *di)
{
    if (power_gpio_config_output(np, "gpio_ch", "charger_channel",
        &di->gpio_ch, CHARGER_CH_USBIN))
        return -ENODEV;

    return 0;
}
```

**初始化流程**：
1. 从设备树节点 `np` 读取 "gpio_ch" 属性
2. 配置 GPIO 为输出模式
3. 设置初始值为 `CHARGER_CH_USBIN` (LOW)，默认选择 USB 通道
4. 保存 GPIO 编号到 `di->gpio_ch`

**设备树示例**：
```dts
charger_channel {
    compatible = "huawei,charger_channel";
    gpio_ch = <&gpio12 5 0>;  // GPIO12_5, 初始LOW
    status = "ok";
};
```

### 4.3 驱动初始化与注销

```c
static int charger_channel_probe(struct platform_device *pdev)
{
    struct charger_ch_dev *di = NULL;
    struct device_node *np = NULL;

    if (!pdev || !pdev->dev.of_node)
        return -ENODEV;

    // 分配设备私有数据
    di = devm_kzalloc(&pdev->dev, sizeof(*di), GFP_KERNEL);
    if (!di)
        return -ENOMEM;

    di->dev = &pdev->dev;
    np = pdev->dev.of_node;
    platform_set_drvdata(pdev, di);

    // 初始化GPIO（默认选择USB通道）
    if (charger_channel_gpio_init(np, di)) {
        hwlog_err("probe: gpio_init fail\n");
        devm_kfree(&pdev->dev, di);
        return -EPROBE_DEFER;  // GPIO未就绪，延迟探测
    }

    // 保存全局指针，供charger_select_channel()使用
    g_charger_ch_di = di;
    hwlog_info("probe ok\n");
    return 0;
}

static int charger_channel_remove(struct platform_device *pdev)
{
    struct ovp_chsw_info *di = platform_get_drvdata(pdev);

    if (!di)
        return -ENODEV;

    // 释放资源
    devm_kfree(&pdev->dev, di);
    platform_set_drvdata(pdev, NULL);
    g_charger_ch_di = NULL;  // 清空全局指针
    return 0;
}
```

**关键设计**：
- 使用 `devm_*` 系列函数，自动资源管理
- 返回 `-EPROBE_DEFER` 支持延迟探测（GPIO 驱动可能晚于本驱动加载）
- 全局指针 `g_charger_ch_di` 提供无需设备查找的快速访问

---

## 5. 典型应用场景

### 5.1 无线充电接收场景

```c
/* wireless_rx_event.c - 无线充电准备就绪 */
static int wlrx_evt_rxic_notifier_call(struct notifier_block *evt_nb,
    unsigned long event, void *data)
{
    struct wlrx_evt_dev *di = container_of(evt_nb, struct wlrx_evt_dev, rxic_nb);

    switch (event) {
    case POWER_NE_WLRX_PREV_READY:  // 无线接收准备就绪
        wlrx_cut_off_wired_channel(di->drv_type);  // 断开有线通道
        charger_select_channel(CHARGER_CH_WLSIN);  // 切换到无线通道 ✓
        return NOTIFY_OK;
    // ... 其他事件处理
    }
}
```

**流程说明**：
1. 无线充电器放置，RX IC 检测到充电器
2. 触发 `POWER_NE_WLRX_PREV_READY` 事件
3. 先断开有线充电路径（避免冲突）
4. **切换硬件通道到 WLSIN**，充电 IC 从无线线圈接收功率
5. 开始无线充电

### 5.2 反向无线充电（OTG）场景

```c
/* wireless_tx_pwr_src.c - 无线反向充电 */
static enum wltx_pwr_src wltx_set_otg_output(bool enable)
{
    if (!enable) {
        // 关闭OTG输出
        (void)charge_otg_mode_enable(false, VBUS_CH_USER_WR_TX);
        charge_pump_chip_enable(CP_TYPE_MAIN, false);
        wlps_control(WLTRX_IC_MAIN, WLPS_RX_SW, false);
        charger_select_channel(CHARGER_CH_USBIN);  // 恢复USB通道 ✓
        wltx_otg_output_set_wired_channel(enable);
        return PWR_SRC_NULL;
    }

    // 使能OTG输出
    wltx_otg_output_set_wired_channel(enable);
    charger_select_channel(CHARGER_CH_WLSIN);  // 切换到无线通道 ✓
    (void)charge_otg_mode_enable(true, VBUS_CH_USER_WR_TX);
    
    // 等待OTG稳定，检查输出电压
    for (i = 0; i < 10; i++) {
        if (wltx_msleep(50))
            goto fail;
        charge_get_vbus(&vout);
        if ((vout >= WLTX_OTG_VOUT_LTH) && (vout < WLTX_OTG_VOUT_HTH)) {
            wlps_control(WLTRX_IC_MAIN, WLPS_RX_SW, true);
            charge_pump_chip_enable(CP_TYPE_MAIN, true);
            return PWR_SRC_OTG;
        }
    }

fail:
    (void)charge_otg_mode_enable(false, VBUS_CH_USER_WR_TX);
    charger_select_channel(CHARGER_CH_USBIN);  // 失败恢复USB通道 ✓
    wltx_otg_output_set_wired_channel(!enable);
    return PWR_SRC_NULL;
}
```

**反向充电流程**：
```
手机给其他设备无线充电
    ↓
Step 1: 切换到 WLSIN 通道
    ↓
Step 2: 使能 OTG 模式（电池 → VBUS 升压）
    ↓
Step 3: 检查 VBUS 电压（5V±0.5V）
    ↓ 正常
Step 4: 使能 TX 发射线圈
    ↓
手机通过无线线圈给外部设备供电

失败时：
    ↓
恢复 USBIN 通道，关闭 OTG
```

### 5.3 5V Boost + 无线发射场景

```c
/* wireless_tx_pwr_src.c - 5V Boost从无线输入 */
static enum wltx_pwr_src wltx_set_5vbst_wlsin_output(bool enable)
{
    if (enable) {
        charger_select_channel(CHARGER_CH_WLSIN);  // 切换到无线通道 ✓
        boost_5v_enable(true, BOOST_CTRL_WLTX);     // 使能5V升压
        wlps_control(WLTRX_IC_MAIN, WLPS_TX_SW, true);  // 使能TX开关
        (void)wlrx_buck_set_dev_iin(100);  // 限制输入电流100mA，防止系统反向抽电
        return PWR_SRC_5VBST_WLSIN;
    }

    // 关闭时
    wltx_5vbst_hiz_ctrl(enable);
    wlps_control(WLTRX_IC_MAIN, WLPS_TX_SW, false);
    boost_5v_enable(false, BOOST_CTRL_WLTX);
    (void)wlrx_buck_set_dev_iin(2000);  // 恢复默认2A限流
    charger_select_channel(CHARGER_CH_USBIN);  // 恢复USB通道 ✓
    return PWR_SRC_NULL;
}
```

**应用场景**：
- 手机正在无线充电，同时通过无线反向给配件（如手表）充电
- 利用无线接收的功率通过 5V Boost 和 TX 线圈发射出去

### 5.4 低功耗模式场景

```c
/* low_power.c - 系统低功耗管理 */
static void low_power_wireless_charge_select_scene(struct low_pwr_dev *di)
{
    // ... 其他逻辑 ...

    if (需要进入无线充电低功耗模式) {
        charger_select_channel(CHARGER_CH_WLSIN);  // 切换到无线通道 ✓
        // 配置低功耗参数
    }
}

static void low_power_wireless_charge_exit_scene(struct low_pwr_dev *di)
{
    // ... 其他逻辑 ...

    if (退出无线充电低功耗模式) {
        charger_select_channel(CHARGER_CH_USBIN);  // 恢复USB通道 ✓
        // 恢复正常功耗参数
    }
}
```

---

## 6. 时序分析

### 6.1 有线 → 无线切换时序

```
时刻 T0: 有线充电中
    CHARGER_CH = USBIN
    GPIO = LOW
    充电IC输入 = USB VBUS
    充电电流 = 3000mA

时刻 T1: 用户放置到无线充电器
    无线RX IC检测到充电器
    ↓ 100ms
    POWER_NE_WLRX_PREV_READY事件
    ↓
    wlrx_cut_off_wired_channel()  // 断开有线VBUS
    ↓ 10ms
    charger_select_channel(CHARGER_CH_WLSIN)  ← GPIO切换
    ↓ 1ms (硬件MUX切换时间)
    
时刻 T2: 通道切换完成
    CHARGER_CH = WLSIN
    GPIO = HIGH
    充电IC输入 = 无线线圈
    ↓
    无线充电握手协议
    ↓ 50ms
    
时刻 T3: 开始无线充电
    充电电流 = 1000mA (Qi协议)
```

**关键时间节点**：
- GPIO 切换时间：< 1ms（硬件 MUX 响应时间）
- 有线断开到无线接通间隔：~10ms（防止 VBUS 冲突）
- 整体切换时延：< 200ms（包括协议握手）

### 6.2 反向充电时序

```
时刻 T0: 正常待机
    CHARGER_CH = USBIN
    OTG = OFF

时刻 T1: 用户启动反向充电
    检查直充是否退出
    ↓ 0-3000ms
    charger_select_channel(CHARGER_CH_WLSIN)  ← GPIO切换
    ↓ 1ms
    
时刻 T2: 使能OTG
    charge_otg_mode_enable(true)
    ↓ 250ms (典型OTG启动时间)
    
时刻 T3: 检查OTG电压
    for (i=0; i<10; i++) {
        读取VBUS电压
        if (4.5V < VBUS < 5.5V)
            成功
    }
    ↓ 最多500ms
    
时刻 T4: 使能TX发射
    wlps_control(WLPS_RX_SW, true)
    charge_pump_chip_enable(CP_TYPE_MAIN, true)
    ↓
    手机开始给外部设备无线充电
```

---

## 7. 调用关系汇总

### 7.1 调用者统计

```c
调用 charger_select_channel() 的模块：

1. wireless_rx (无线充电接收)
   - wireless_rx_event.c
     └─ wlrx_evt_rxic_notifier_call()
        └─ case POWER_NE_WLRX_PREV_READY:
           └─ charger_select_channel(CHARGER_CH_WLSIN)

2. wireless_tx (无线反向充电)
   - wireless_tx_pwr_src.c
     ├─ wltx_set_otg_output(enable)
     │  ├─ enable=true:  charger_select_channel(CHARGER_CH_WLSIN)
     │  └─ enable=false: charger_select_channel(CHARGER_CH_USBIN)
     │
     ├─ wltx_set_5vbst_wlsin_output(enable)
     │  ├─ enable=true:  charger_select_channel(CHARGER_CH_WLSIN)
     │  └─ enable=false: charger_select_channel(CHARGER_CH_USBIN)
     │
     └─ wltx_set_otg_output() fail路径
        └─ charger_select_channel(CHARGER_CH_USBIN)

3. low_power (低功耗管理)
   - low_power.c
     ├─ low_power_wireless_charge_select_scene()
     │  └─ charger_select_channel(CHARGER_CH_WLSIN)
     │
     └─ low_power_wireless_charge_exit_scene()
        └─ charger_select_channel(CHARGER_CH_USBIN)
```

### 7.2 使用频率分析

| 场景 | 调用频率 | 切换方向 | 优先级 |
|------|---------|---------|--------|
| 无线充电开始 | 低（用户操作） | USB → WLSIN | 高 |
| 无线充电结束 | 低（用户操作） | WLSIN → USB | 高 |
| 反向充电开始 | 极低（偶尔使用） | USB → WLSIN | 中 |
| 反向充电结束 | 极低 | WLSIN → USB | 中 |
| 低功耗模式 | 低（自动触发） | 双向切换 | 低 |

---

## 8. 设计特点与优势

### 8.1 设计模式

**单例模式（Singleton）**：
```c
static struct charger_ch_dev *g_charger_ch_di;  // 全局唯一实例

void charger_select_channel(int channel)
{
    struct charger_ch_dev *di = g_charger_ch_di;  // 直接访问全局实例
    // ...
}
```

**优势**：
- ✅ 无需设备查找，访问速度快
- ✅ 代码简洁，调用方便
- ✅ 适合硬件唯一的场景

**劣势**：
- ⚠️ 不支持多实例（但硬件也确实只有一个 MUX）
- ⚠️ 全局变量，模块化较弱

### 8.2 极简主义

**代码量**：仅 140 行
**核心函数**：1 个（`charger_select_channel`）
**数据结构**：1 个（`charger_ch_dev`）

**哲学**：
> Do one thing and do it well.

该模块只做一件事：**切换 GPIO 控制硬件 MUX**，不涉及任何充电逻辑，符合 Unix 哲学。

### 8.3 无状态设计

```c
void charger_select_channel(int channel)
{
    // 不记录当前状态
    // 不判断是否需要切换
    // 直接执行GPIO操作
    gpio_set_value(di->gpio_ch, gpio_val);
}
```

**特点**：
- 无状态机，不维护当前通道信息
- 每次调用都执行 GPIO 操作（即使已经是目标通道）
- 依赖上层模块管理状态

**优势**：
- ✅ 代码简单，不易出错
- ✅ 无状态同步问题

**劣势**：
- ⚠️ 可能有冗余 GPIO 操作（影响很小，GPIO 操作很快）

---

## 9. 潜在问题与改进建议

### 9.1 并发安全

**当前问题**：
```c
void charger_select_channel(int channel)
{
    // 无锁保护！
    gpio_set_value(di->gpio_ch, gpio_val);
}
```

**风险场景**：
```
线程A: 无线RX准备，调用 charger_select_channel(CHARGER_CH_WLSIN)
线程B: 低功耗退出，调用 charger_select_channel(CHARGER_CH_USBIN)

如果时序：
T1: A设置GPIO=HIGH
T2: B设置GPIO=LOW
结果: 无线RX预期WLSIN，实际为USBIN → 充电失败！
```

**改进建议**：
```c
static DEFINE_MUTEX(g_charger_ch_lock);

void charger_select_channel(int channel)
{
    struct charger_ch_dev *di = g_charger_ch_di;
    
    if (!di) {
        hwlog_err("charger_select_channel: di invalid\n");
        return;
    }

    mutex_lock(&g_charger_ch_lock);  // 加锁保护
    
    if (channel == CHARGER_CH_USBIN)
        gpio_val = 0;
    else if (channel == CHARGER_CH_WLSIN)
        gpio_val = 1;
    else {
        mutex_unlock(&g_charger_ch_lock);
        return;
    }

    gpio_set_value(di->gpio_ch, gpio_val);
    hwlog_info("[select_channel] gpio %s now\n",
        gpio_get_value(di->gpio_ch) ? "high" : "low");
    
    mutex_unlock(&g_charger_ch_lock);
}
```

### 9.2 状态记录与去重

**当前问题**：每次调用都操作 GPIO，即使已经是目标通道

**改进建议**：
```c
struct charger_ch_dev {
    struct device *dev;
    int gpio_ch;
    int current_channel;  // 新增：当前通道状态
    struct mutex lock;    // 新增：互斥锁
};

void charger_select_channel(int channel)
{
    struct charger_ch_dev *di = g_charger_ch_di;
    int gpio_val;
    
    if (!di || (channel != CHARGER_CH_USBIN && channel != CHARGER_CH_WLSIN))
        return;

    mutex_lock(&di->lock);
    
    // 去重优化
    if (di->current_channel == channel) {
        hwlog_info("[select_channel] already in channel %d, skip\n", channel);
        mutex_unlock(&di->lock);
        return;
    }

    gpio_val = (channel == CHARGER_CH_WLSIN) ? 1 : 0;
    gpio_set_value(di->gpio_ch, gpio_val);
    di->current_channel = channel;  // 更新状态
    
    hwlog_info("[select_channel] switch to %s\n",
        channel == CHARGER_CH_USBIN ? "USBIN" : "WLSIN");
    
    mutex_unlock(&di->lock);
}
```

### 9.3 异常保护

**当前问题**：未校验 GPIO 是否初始化成功

**改进建议**：
```c
static int charger_channel_gpio_init(struct device_node *np, struct charger_ch_dev *di)
{
    int ret;
    
    ret = power_gpio_config_output(np, "gpio_ch", "charger_channel",
        &di->gpio_ch, CHARGER_CH_USBIN);
    if (ret)
        return -ENODEV;

    // 验证GPIO是否可读写
    gpio_set_value(di->gpio_ch, 0);
    if (gpio_get_value(di->gpio_ch) != 0) {
        hwlog_err("gpio_init: gpio read-back failed\n");
        return -EIO;
    }

    gpio_set_value(di->gpio_ch, 1);
    if (gpio_get_value(di->gpio_ch) != 1) {
        hwlog_err("gpio_init: gpio read-back failed\n");
        return -EIO;
    }

    // 恢复默认通道
    gpio_set_value(di->gpio_ch, 0);
    
    return 0;
}
```

---

## 10. 调试方法

### 10.1 日志追踪

```bash
# 使能 charger_channel 日志
echo 8 > /proc/sys/kernel/printk

# 过滤相关日志
dmesg | grep "charger_channel"

# 典型日志输出
[  xxx.xxx] charger_channel: probe ok
[  xxx.xxx] charger_channel: [select_channel] gpio high now
[  xxx.xxx] charger_channel: [select_channel] gpio low now
```

### 10.2 GPIO 状态查询

```bash
# 查看所有GPIO状态
cat /sys/kernel/debug/gpio

# 查找charger_channel的GPIO
cat /sys/kernel/debug/gpio | grep charger_channel

# 输出示例
gpio-197 (charger_channel  ) out lo
```

### 10.3 设备树配置检查

```bash
# 查看运行时设备树
cat /proc/device-tree/charger_channel/compatible
# 输出: huawei,charger_channel

cat /proc/device-tree/charger_channel/gpio_ch
# 输出: GPIO编号的二进制数据
```

### 10.4 手动测试

```bash
# 获取GPIO编号（假设为197）
GPIO_NUM=197

# 导出GPIO
echo $GPIO_NUM > /sys/class/gpio/export

# 设置为输出模式
echo out > /sys/class/gpio/gpio${GPIO_NUM}/direction

# 切换到USBIN (LOW)
echo 0 > /sys/class/gpio/gpio${GPIO_NUM}/value

# 读取当前值
cat /sys/class/gpio/gpio${GPIO_NUM}/value
# 输出: 0

# 切换到WLSIN (HIGH)
echo 1 > /sys/class/gpio/gpio${GPIO_NUM}/value

# 读取当前值
cat /sys/class/gpio/gpio${GPIO_NUM}/value
# 输出: 1
```

---

## 11. 与其他模块的关系

### 11.1 在充电框架中的位置

```
充电管理总体框架
    ├─ cc_charger/ (充电管理器)
    │  ├─ wireless_charge/
    │  │  ├─ wireless_rx  ────┐
    │  │  └─ wireless_tx  ────┤
    │  └─ buck_charge/         │
    │                          │ 调用
    ├─ cc_hardware_monitor/    │ charger_select_channel()
    │  └─ low_power/  ─────────┤
    │                          │
    ├─ cc_hardware_channel/ ◄──┘
    │  └─ charger_channel  ← 本模块
    │
    └─ 硬件层
       ├─ USB Type-C
       ├─ 无线充电线圈
       └─ 硬件MUX
```

### 11.2 依赖关系

**被依赖（Providers）**：
```
charger_channel
    ↓ 提供服务
wireless_rx、wireless_tx、low_power
```

**依赖（Consumers）**：
```
charger_channel
    ↓ 使用服务
power_gpio (GPIO操作)
platform_driver (驱动框架)
```

---

## 12. 总结

### 12.1 核心价值

`charger_channel` 是华为充电框架中的**硬件通道仲裁者**，虽然代码极简（140行），但在复杂的充电系统中扮演关键角色：

1. **物理隔离**：确保 USB 和无线充电互不干扰
2. **资源复用**：单一充电 IC 支持多种充电方式
3. **成本优化**：避免重复硬件，降低BOM成本

### 12.2 设计哲学

- **极简主义**：单一功能，代码最少化
- **无状态化**：不维护复杂状态机
- **全局可访问**：简化调用路径
- **硬件直控**：直接操作GPIO，无中间层

### 12.3 适用场景

✅ **适合**：
- 硬件唯一，无多实例需求
- 切换频率低（秒级以上）
- 对延迟不敏感（毫秒级可接受）

❌ **不适合**：
- 需要高频切换（微秒级）
- 需要严格的并发控制
- 需要复杂的状态管理

### 12.4 技术亮点

| 特性 | 实现 | 优势 |
|------|------|------|
| 极简设计 | 140行代码 | 易维护，不易出错 |
| 无锁快速访问 | 全局指针 | 低延迟，高性能 |
| 硬件抽象 | GPIO操作 | 平台无关 |
| 日志完善 | 每次切换打印 | 易调试追踪 |

---

## 13. 参考资料

- charger_channel.c
- charger_channel.h
- 调用者代码：
  - wireless_rx_event.c
  - wireless_tx_pwr_src.c
