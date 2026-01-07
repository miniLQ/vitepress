---
outline: deep
---

# Low Power 模块分析

## 一、模块概述

### 1.1 功能定位
**Low Power (低功耗控制)** 是华为 MATE X5 电源管理系统中的**极低电量应急供电模块**，主要负责在电池电量极低、温度极低等极端场景下，通过 **Boost 升压电路提升系统电压（VSYS）**，确保设备能够维持基本通讯功能（如紧急拨号、GSM 通话），延长关机前的续航时间。

### 1.2 核心功能
- **ECM (Emergency Mode，应急模式)**：电量极低时自动启动 Boost 电路维持系统运行
- **LTM (Low Temperature Mode，低温模式)**：低温环境下通过 Boost 提升电压改善放电性能
- **智能 Boost 控制**：根据电池电压、放电电流、温度等多维度条件动态开关 Boost
- **双重安全退出**：检测到充电插入或电压恢复时自动退出应急模式
- **GSM 通话保护**：在 GSM 通话中检测电压跌落，防止通话中断
- **屏幕状态感知**：屏幕开关时重新评估是否需要 Boost

### 1.3 设计背景
在极低电量（如 1%-3%）或极低温度（如 -15°C）场景下，电池内阻升高导致负载电压跌落严重。当 VBAT（电池电压）低于 3.1V 时，系统可能无法正常运行。通过 Buck-Boost 电路将低电池电压升压至稳定的系统电压（如 3.8V-4.0V），可以：
- 延长设备关机前的可用时间（额外 5-10 分钟）
- 保障紧急通讯功能（GSM 拨号、SOS 呼叫）
- 改善低温放电性能

---

## 二、系统架构

### 2.1 模块组成
```
low_power 模块
├── low_power.c         # 主控制逻辑（ECM/LTM 状态机、Boost 控制）
├── low_power.h         # 数据结构定义
├── Kconfig             # 内核配置
└── Makefile            # 编译配置
```

### 2.2 架构分层
```
+---------------------------------------------------------------+
|                    User Space                                 |
|  /sys/class/hw_power/low_power/                               |
|    ├─ support_ecm (只读)                                       |
|    ├─ trigger_ecm (读写)                                       |
|    └─ gsm_ecm (读写)                                           |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Low Power State Machine (状态机)                 |
|  ECM (Emergency Mode):                                        |
|    - ECM_TRIGGER_IDLE: 空闲                                   |
|    - ECM_TRIGGER_CN: 国内应急模式                             |
|    - ECM_TRIGGER_OVERSEA: 海外应急模式                        |
|  LTM (Low Temperature Mode):                                 |
|    - LTM_MONITOR_IDLE: 空闲                                   |
|    - LTM_MONITOR_WORKING: 低温监控中                          |
|    - LTM_MONITOR_EXIT: 退出监控                               |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Boost Control Layer (升压控制)                   |
|  low_power_boost_vsys_enable():                               |
|    - LPM_BST_TYPE_CHG_EN: 充电 IC 使能控制                    |
|    - LPM_BST_TYPE_Q4: Q4 开关管控制                           |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Hardware Layer (硬件层)                          |
|  - Buck-Boost IC (升压至 3.8V-4.0V)                           |
|  - GPIO Switch (VSYS 通路切换)                                |
|  - Charger IC (充电通道切换)                                   |
|  - Wireless RX/TX Switch (无线充电路径切换)                    |
+---------------------------------------------------------------+
```

### 2.3 工作流程概览
```
触发条件检测
    ↓
┌─────────────────────────────────────────────────┐
│  1. ECM 触发条件（二选一）                        │
│     - Sysfs 手动触发: trigger_ecm = CN/OVERSEA   │
│     - 电量低: UI Capacity ≤ 阈值（如 3%）         │
│  2. LTM 触发条件（三个条件同时满足）               │
│     - 温度低: TBAT < -15°C                        │
│     - 电量低: UI Capacity ≤ 10%                   │
│     - 无充电: 未插充电器                           │
└─────────────────────────────────────────────────┘
    ↓
启动 lpm_work 工作队列（周期 5s 或 80ms）
    ↓
┌─────────────────────────────────────────────────┐
│  状态检测循环                                     │
│  1. 检查退出条件:                                 │
│     - 充电器插入 → 退出                           │
│     - 电压恢复 → 退出                             │
│     - 温度上升 → 退出（LTM）                      │
│  2. 检查 Boost 条件:                              │
│     - VBAT < 3.1V → 启动 Boost                   │
│     - idischrg > 150mA → 启动 Boost              │
│  3. 检查电压危险:                                 │
│     - VBAT < shutdown_th → 强制关机              │
│     - VBAT < gsm_th + GSM 通话 → 关机            │
└─────────────────────────────────────────────────┘
    ↓
Boost 控制执行
    ↓
┌─────────────────────────────────────────────────┐
│  Boost 开启流程 (LPM_BST_TYPE_CHG_EN):           │
│  1. 切换充电通道到 WLSIN                          │
│  2. 开启 BUCK 通道                                │
│  3. 启动 5V Boost                                 │
│  4. 打开 VBUSIN 开关                              │
│  5. 打开 RX Switch                                │
│  6. 禁用 Charger IC                               │
│  7. 启动 Buck-Boost 升压（3.8V）                  │
│  8. 打开 VSYS 开关 GPIO                           │
└─────────────────────────────────────────────────┘
```

---

## 三、核心数据结构

### 3.1 应急模式参数（ECM）
```c
struct emergency_mode_para {
    u32 vbat_bst_th;         // Boost 启动电压阈值（mV，如 3100mV）
    u32 vbat_shutdown_th;    // 关机电压阈值（mV，如 3050mV）
    u32 vbat_gsm;            // GSM 通话保护电压（mV，如 3200mV）
    u32 trigger_status;      // 触发状态（IDLE/CN/OVERSEA）
    u32 gsm_status;          // GSM 状态（IDLE/WORKING）
    int event_type;          // 事件类型（DEFAULT/UNDER_VOLT/EXIT_ECM）
    bool bst_vsys;           // Boost 使能标志
};

enum ecm_trigger_type {
    ECM_TRIGGER_IDLE,        // 空闲状态
    ECM_TRIGGER_CN,          // 国内应急模式
    ECM_TRIGGER_OVERSEA,     // 海外应急模式
};

enum ecm_gsm_type {
    ECM_GSM_IDLE,            // GSM 空闲
    ECM_GSM_WORKING,         // GSM 通话中
};
```

### 3.2 低温模式参数（LTM）
```c
struct low_temp_mode_para {
    int temp_th;             // 温度阈值（°C，如 -15°C）
    u32 soc_th;              // 电量阈值（%，如 10%）
    int monitor_type;        // 监控状态（IDLE/WORKING/EXIT）
    bool bst_vsys;           // Boost 使能标志
};

enum ltm_mon_type {
    LTM_MONITOR_IDLE,        // 空闲
    LTM_MONITOR_WORKING,     // 监控中
    LTM_MONITOR_EXIT,        // 退出监控
};
```

### 3.3 设备管理结构
```c
struct low_power_dev {
    struct device *dev;                        // Sysfs 设备
    struct delayed_work lpm_work;              // 延迟工作队列
    struct notifier_block ui_cap_nb;           // UI 电量通知器
    struct notifier_block plugged_nb;          // 充电插拔通知器
    struct notifier_block wltx_dping_nb;       // 无线 TX Dping 通知器
    struct notifier_block fb_nb;               // 屏幕状态通知器
    struct wakeup_source *wakelock;            // 唤醒锁
    
    // GPIO 控制
    int gpio_bst_vsys_sw;                      // VSYS Boost 开关 GPIO
    int gpio_bst_chg_sw;                       // 充电开关 GPIO
    
    // 配置参数
    int boost_type;                            // Boost 类型（CHG_EN/Q4）
    int vbusin_pssw_type;                      // VBUSIN 开关类型（TXSW/GPIO）
    u32 support_ecm;                           // 是否支持 ECM
    u32 support_ltm;                           // 是否支持 LTM
    
    // 电流阈值（动态调整）
    int icost_bst;                             // Boost 模式额外功耗（mA，如 150mA）
    int idischrg_en_bst_th;                    // 启动 Boost 电流阈值（mA）
    int idischrg_dis_bst_th;                   // 关闭 Boost 电流阈值（mA）
    
    // 模式参数
    struct emergency_mode_para ecm;            // ECM 参数
    struct low_temp_mode_para ltm;             // LTM 参数
    
    // 运行状态
    bool boost_vsys_status;                    // Boost 当前状态
    bool plugin_status;                        // 充电器插入状态
    bool wltx_dping_status;                    // 无线 TX Dping 状态
    int screen_state;                          // 屏幕状态（ON/OFF）
    int ui_capacity;                           // UI 显示电量（%）
    unsigned int work_interval;                // 工作队列间隔（ms）
    unsigned int lpm_bbst_vout[2];             // Buck-Boost 输出电压（进入/退出）
};
```

### 3.4 Boost 类型枚举
```c
enum lpm_bst_type {
    LPM_BST_TYPE_CHG_EN,     // 通过充电 IC 使能控制 Boost
    LPM_BST_TYPE_Q4,         // 通过 Q4 开关管控制 Boost
    LPM_BST_TYPE_NOOP,       // 由其他模块控制 Boost（本模块无操作）
};
```

---

## 四、核心算法与工作流程

### 4.1 ECM 状态检测算法（low_power_ecm_status_check）

```c
static void low_power_ecm_status_check(struct low_power_dev *l_dev)
{
    int vbat;
    int shutdown_th;
    
    // 1. 检查是否启用 ECM 且状态不为 IDLE
    if (!l_dev->support_ecm || (l_dev->ecm.trigger_status == ECM_TRIGGER_IDLE))
        return;
    
    // 2. 获取关机电压阈值（从 OCV 表或 DTS 配置）
    shutdown_th = low_power_get_shutdown_th(l_dev);
    
    // 3. 读取最大 VBAT（3 次采样取最大值）
    vbat = low_power_get_vbat(LPM_VBAT_TYPE_MAX);
    
    // 4. 检查是否需要强制关机（电压过低或 GSM 通话中电压低）
    if ((vbat <= shutdown_th) || 
        ((vbat <= l_dev->ecm.vbat_gsm) && (l_dev->ecm.gsm_status != ECM_GSM_IDLE))) {
        l_dev->ecm.bst_vsys = false;
        l_dev->ecm.event_type = LPM_EVENT_UNDER_VOLT;  // 触发欠压事件
        return;
    }
    
    // 5. 检查是否插入充电器或无线 TX Dping
    if (l_dev->plugin_status || l_dev->wltx_dping_status) {
        l_dev->ecm.bst_vsys = false;
        l_dev->ecm.event_type = LPM_EVENT_EXIT_ECM;    // 退出 ECM
        return;
    }
    
    // 6. 检查电压是否高于 Boost 阈值
    vbat = low_power_get_vbat(LPM_VBAT_TYPE_MIN);  // 取最小值判断
    if (vbat > l_dev->ecm.vbat_bst_th) {
        l_dev->ecm.bst_vsys = false;  // 电压恢复，关闭 Boost
        return;
    }
    
    // 7. 检查放电电流是否需要 Boost
    if (!low_power_check_idischarge(l_dev, &l_dev->ecm.bst_vsys))
        return;
    
    // 8. 默认启动 Boost
    l_dev->ecm.bst_vsys = true;
}
```

**关键逻辑解释**：
- **多次采样**：VBAT 采样 3 次，取最大值判断关机条件（避免瞬时跌落误判），取最小值判断 Boost 条件（防止漏判）
- **GSM 特殊保护**：GSM 通话时如果 VBAT < 3200mV，即使高于关机电压也强制关机（防止通话中断）
- **充电器优先**：检测到充电器插入立即退出 ECM，Boost 交由充电系统管理

### 4.2 LTM 状态检测算法（low_power_ltm_status_check）

```c
static void low_power_ltm_status_check(struct low_power_dev *l_dev)
{
    int tbatt = 0;
    
    // 1. 检查是否启用 LTM 且状态不为 IDLE
    if (!l_dev->support_ltm || (l_dev->ltm.monitor_type == LTM_MONITOR_IDLE))
        return;
    
    // 2. 检查电量是否恢复（高于 SOC 阈值）
    if (l_dev->ui_capacity > l_dev->ltm.soc_th) {
        l_dev->ltm.bst_vsys = false;
        l_dev->ltm.monitor_type = LTM_MONITOR_EXIT;  // 标记退出
        return;
    }
    
    // 3. 读取电池温度
    bat_temp_get_temperature(BAT_TEMP_MIXED, &tbatt);
    
    // 4. 检查退出条件
    if (l_dev->plugin_status ||           // 充电器插入
        l_dev->wltx_dping_status ||       // 无线 TX Dping
        (tbatt > l_dev->ltm.temp_th)) {   // 温度上升
        l_dev->ltm.bst_vsys = false;
        return;
    }
    
    // 5. 检查放电电流
    if (!low_power_check_idischarge(l_dev, &l_dev->ltm.bst_vsys))
        return;
    
    // 6. 默认启动 Boost
    l_dev->ltm.bst_vsys = true;
}
```

**低温启动条件**（在 UI Capacity 变化事件中检查）：
```c
if (l_dev->support_ltm && 
    (tbatt < 0°C) &&                      // 温度低于 0°C
    (l_dev->ui_capacity <= l_dev->ltm.soc_th) &&  // 电量 ≤ 10%
    (l_dev->ltm.monitor_type == LTM_MONITOR_IDLE)) {
    l_dev->ltm.monitor_type = LTM_MONITOR_WORKING;
    // 启动监控
}
```

### 4.3 放电电流检测算法（low_power_check_idischarge）

```c
static int low_power_check_idischarge(struct low_power_dev *l_dev, bool *bst_vsys)
{
    int idischrg;
    
    // 读取电池放电电流（正值表示放电）
    idischrg = power_platform_get_battery_current();
    
    hwlog_info("[check_idischarge] idischrg=%dmA\n", idischrg);
    
    // 电流高于阈值：启动 Boost
    if (idischrg > l_dev->idischrg_en_bst_th) {
        *bst_vsys = true;
        return 0;
    }
    
    // 电流低于阈值：关闭 Boost
    if (idischrg < l_dev->idischrg_dis_bst_th) {
        *bst_vsys = false;
        return 0;
    }
    
    // 电流在滞回区间：保持当前状态不变
    return -EINVAL;
}
```

**滞回逻辑**（防止频繁开关）：
- 启动阈值：150mA（基准）+ 150mA（Boost 功耗）= **300mA**
- 关闭阈值：100mA（基准）+ 150mA（Boost 功耗）= **250mA**
- 滞回区间：250mA ~ 300mA 之间保持当前状态

**动态阈值调整**：
```c
static void low_power_set_idischrg_bst_th(struct low_power_dev *l_dev)
{
    l_dev->idischrg_en_bst_th = LPM_IBAT_EN_BST_TH;   // 150mA
    l_dev->idischrg_dis_bst_th = LPM_IBAT_DIS_BST_TH; // 100mA
    
    // 如果 Boost 已启动，补偿 Boost 自身功耗
    if (l_dev->boost_vsys_status) {
        l_dev->idischrg_en_bst_th += l_dev->icost_bst;   // +150mA
        l_dev->idischrg_dis_bst_th += l_dev->icost_bst;  // +150mA
    }
}
```

### 4.4 Boost 控制算法（low_power_boost_vsys_enable）

#### 4.4.1 CHG_EN 模式（LPM_BST_TYPE_CHG_EN）

**开启流程**：
```c
static void low_power_boost_vsys_chg_en(struct low_power_dev *l_dev, bool enable)
{
    if (enable) {
        // 1. 切换充电通道到 WLSIN（无线充电输入）
        charger_select_channel(CHARGER_CH_WLSIN);
        
        // 2. 开启 WDCM BUCK 通道
        wdcm_set_buck_channel_state(WDCM_CLIENT_LPM, WDCM_DEV_ON);
        power_usleep(10ms);  // 等待 BUCK 通道稳定
        
        // 3. 启动 5V Boost
        boost_5v_enable(true, BOOST_CTRL_LOW_POWER);
        
        // 4. 打开 VBUSIN 开关（根据类型选择 TXSW 或 GPIO）
        low_power_restore_vbusin_sw(l_dev, true);
        
        // 5. 打开 RX Switch（无线接收开关）
        wlps_control(WLTRX_IC_MAIN, WLPS_RX_SW, true);
        
        // 6. 延迟 100ms 等待通路稳定
        power_msleep(100ms);
        
        // 7. 设置充电 IC 输入电流限制为 100mA
        wlrx_buck_set_dev_iin(100);
        
        // 8. 禁用充电 IC（防止反向充电）
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
            POWER_IF_SYSFS_ENABLE_CHARGER, LPM_CHG_DISABLE);
        
        // 9. 延迟 500ms 确保充电 IC 完全关闭
        power_msleep(500ms);
        
        // 10. 启动 Buck-Boost 并设置输出电压（如 3800mV）
        buck_boost_set_enable(LPM_ENABLE, BBST_USER_LPM);
        buck_boost_set_vout(l_dev->lpm_bbst_vout[LPM_BBST_ENTER_VOL], BBST_USER_LPM);
        
        // 11. 打开 VSYS 开关 GPIO
        gpio_set_value(l_dev->gpio_bst_vsys_sw, 1);
    }
}
```

**关闭流程**（反向操作）：
```c
else {
    // 1. 关闭 VSYS 开关 GPIO
    gpio_set_value(l_dev->gpio_bst_vsys_sw, 0);
    
    // 2. 设置 Buck-Boost 退出电压并关闭
    buck_boost_set_vout(l_dev->lpm_bbst_vout[LPM_BBST_EXIT_VOL], BBST_USER_LPM);
    buck_boost_set_enable(LPM_DISABLE, BBST_USER_LPM);
    
    // 3. 关闭 RX Switch
    wlps_control(WLTRX_IC_MAIN, WLPS_RX_SW, false);
    
    // 4. 关闭 VBUSIN 开关
    low_power_restore_vbusin_sw(l_dev, false);
    
    // 5. 关闭 5V Boost
    boost_5v_enable(false, BOOST_CTRL_LOW_POWER);
    power_usleep(10ms);
    
    // 6. 切换充电通道回 USBIN
    charger_select_channel(CHARGER_CH_USBIN);
    wdcm_set_buck_channel_state(WDCM_CLIENT_LPM, WDCM_DEV_OFF);
    
    // 7. 恢复充电 IC 使能
    power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
        POWER_IF_SYSFS_ENABLE_CHARGER, LPM_CHG_ENABLE);
    
    // 8. 恢复输入电流限制为 2000mA
    wlrx_buck_set_dev_iin(2000);
}
```

**电路原理**：
```
电池 (3.0V) → Buck-Boost (升压到 3.8V) → VSYS Switch → VSYS (系统供电)
                    ↑
                5V Boost (为 Buck-Boost 提供输入)
                    ↑
              VBUSIN Switch (打开通路)
```

#### 4.4.2 Q4 模式（LPM_BST_TYPE_Q4）

```c
static void low_power_boost_vsys_q4_en(struct low_power_dev *l_dev, bool enable)
{
    if (enable) {
        // 1. 设置充电 IC 进入低功耗模式
        charge_set_low_power_mode_enable(true);
        
        // 2. 启动 Buck-Boost 和 VSYS 开关
        low_power_boost_vsys(l_dev, true);
    } else {
        // 1. 关闭 Buck-Boost 和 VSYS 开关
        low_power_boost_vsys(l_dev, false);
        
        // 2. 退出充电 IC 低功耗模式
        charge_set_low_power_mode_enable(false);
    }
}
```

**Q4 模式特点**：
- 通过充电 IC 的 Q4 开关管控制 Boost
- 无需复杂的通道切换
- 适用于支持低功耗模式的新型充电 IC

### 4.5 工作队列调度算法（low_power_lpm_work）

```c
static void low_power_lpm_work(struct work_struct *work)
{
    struct low_power_dev *l_dev = container_of(work, ...);
    
    // 1. 执行 ECM 状态检测
    low_power_ecm_status_check(l_dev);
    
    // 2. 执行 LTM 状态检测
    low_power_ltm_status_check(l_dev);
    
    hwlog_info("ecm: trigger=%u bst=%d, ltm: mon=%d bst=%d\n",
        l_dev->ecm.trigger_status, l_dev->ecm.bst_vsys,
        l_dev->ltm.monitor_type, l_dev->ltm.bst_vsys);
    
    // 3. 处理状态变化（启动/关闭 Boost、发送事件）
    low_power_lpm_status_process(l_dev);
    
    // 4. 检查是否需要退出工作队列
    if (low_power_lpm_work_check_exit(l_dev))
        goto exit;
    
    // 5. 设置下次调度间隔
    low_power_set_work_interval(l_dev);
    
    // 6. 重新调度工作队列
    schedule_delayed_work(&l_dev->lpm_work, msecs_to_jiffies(l_dev->work_interval));
    
exit:
    power_wakeup_unlock(l_dev->wakelock, false);
}
```

**工作间隔设置**：
```c
static void low_power_set_work_interval(struct low_power_dev *l_dev)
{
    if (l_dev->support_ecm && (l_dev->ecm.trigger_status != ECM_TRIGGER_IDLE))
        l_dev->work_interval = LPM_ECM_WORK_INTERVAL;  // 80ms（高优先级）
    else
        l_dev->work_interval = LPM_DFLT_WORK_INTERVAL; // 5000ms（正常）
}
```

**设计意图**：
- ECM 模式下使用 80ms 快速轮询，及时响应电压/电流变化
- 非 ECM 模式下使用 5s 慢速轮询，降低功耗

---

## 五、事件处理机制

### 5.1 UI 电量变化事件

```c
static int low_power_ui_cap_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    int tbatt = 0;
    
    switch (event) {
    case POWER_NE_BAT_UI_CAP_CHAGNED:
        l_dev->ui_capacity = *(int *)data;  // 更新 UI 电量
        l_dev->wltx_dping_status = false;
        
        bat_temp_get_temperature(BAT_TEMP_MIXED, &tbatt);
        
        // 检查 LTM 启动条件
        if (l_dev->support_ltm && 
            (tbatt < 0°C) &&                // 温度 < 0°C
            (l_dev->ui_capacity <= l_dev->ltm.soc_th) &&  // 电量 ≤ 10%
            (l_dev->ltm.monitor_type == LTM_MONITOR_IDLE)) {
            
            l_dev->ltm.monitor_type = LTM_MONITOR_WORKING;
            power_wakeup_lock(l_dev->wakelock, false);
            mod_delayed_work(system_wq, &l_dev->lpm_work, msecs_to_jiffies(0));
            
            hwlog_info("triggered ltm monitor\n");
        }
        break;
    }
    
    return NOTIFY_OK;
}
```

### 5.2 充电器插拔事件

```c
static int low_power_plugged_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_USB_DISCONNECT:
    case POWER_NE_WIRELESS_DISCONNECT:
        low_power_vbus_plugged_handler(l_dev, false);  // 拔出
        break;
        
    case POWER_NE_USB_CONNECT:
    case POWER_NE_WIRELESS_CONNECT:
        low_power_vbus_plugged_handler(l_dev, true);   // 插入
        break;
    }
    
    return NOTIFY_OK;
}
```

**插拔处理逻辑**：
```c
static void low_power_vbus_plugged_handler(struct low_power_dev *l_dev, bool status)
{
    l_dev->plugin_status = status;
    l_dev->wltx_dping_status = false;
    
    // 如果不在 ECM/LTM 模式，直接返回
    if ((l_dev->ecm.trigger_status == ECM_TRIGGER_IDLE) &&
        (l_dev->ltm.monitor_type == LTM_MONITOR_IDLE))
        return;
    
    hwlog_info("[vbus_plugged_handler] plugin_status:%d\n", status);
    
    // 取消之前的工作队列
    cancel_delayed_work_sync(&l_dev->lpm_work);
    
    // 如果插入充电器，立即关闭 Boost
    if (l_dev->plugin_status)
        low_power_boost_vsys_enable(l_dev, false);
    
    // 延迟 50ms 后重新评估状态（消抖）
    power_wakeup_lock(l_dev->wakelock, false);
    mod_delayed_work(system_wq, &l_dev->lpm_work, msecs_to_jiffies(50));
}
```

### 5.3 无线 TX Dping 事件

```c
static int low_power_wltx_dping_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_WLTX_RCV_DPING:
        low_power_wltx_dping_handler(l_dev);
        break;
    }
    
    return NOTIFY_OK;
}
```

**Dping 处理逻辑**：
```c
static void low_power_wltx_dping_handler(struct low_power_dev *l_dev)
{
    // 仅在 CHG_EN 模式下处理（需要切换通道）
    if (l_dev->boost_type != LPM_BST_TYPE_CHG_EN)
        return;
    
    hwlog_info("wltx_dping_handler\n");
    
    cancel_delayed_work_sync(&l_dev->lpm_work);
    l_dev->wltx_dping_status = true;
    
    // 立即关闭 Boost（为无线 TX 让路）
    low_power_boost_vsys_enable(l_dev, false);
    
    power_wakeup_lock(l_dev->wakelock, false);
    mod_delayed_work(system_wq, &l_dev->lpm_work, msecs_to_jiffies(0));
}
```

**设计意图**：
- 无线反向充电（TX 模式）需要使用 5V Boost
- 检测到 Dping（无线设备靠近）时，立即关闭 Low Power 的 Boost
- 避免与无线 TX 的 Boost 冲突

### 5.4 屏幕状态事件

```c
static int low_power_fb_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_PANEL_BLANK:      // 屏幕关闭
        l_dev->screen_state = LPM_SCREEN_OFF;
        hwlog_info("fb screen off\n");
        low_power_fb_handler(l_dev);
        break;
        
    case POWER_NE_PANEL_UNBLANK:    // 屏幕打开
        l_dev->screen_state = LPM_SCREEN_ON;
        hwlog_info("fb screen on\n");
        low_power_fb_handler(l_dev);
        break;
    }
    
    return NOTIFY_OK;
}
```

**屏幕事件处理**：
```c
static void low_power_fb_handler(struct low_power_dev *l_dev)
{
    // 如果不在 ECM/LTM 模式，直接返回
    if ((l_dev->ecm.trigger_status == ECM_TRIGGER_IDLE) &&
        (l_dev->ltm.monitor_type == LTM_MONITOR_IDLE))
        return;
    
    // 延迟 5s 后重新评估状态
    cancel_delayed_work_sync(&l_dev->lpm_work);
    power_wakeup_lock(l_dev->wakelock, false);
    mod_delayed_work(system_wq, &l_dev->lpm_work, msecs_to_jiffies(LPM_FB_WORK_DELAY));
}
```

**设计意图**：
- 屏幕开关导致功耗变化，可能影响放电电流判断
- 延迟 5s 等待系统稳定后重新评估 Boost 需求

---

## 六、Sysfs 接口

### 6.1 节点路径
```bash
/sys/class/hw_power/low_power/
├── support_ecm    # 只读：是否支持 ECM
├── trigger_ecm    # 读写：触发 ECM 模式
└── gsm_ecm        # 读写：GSM 状态
```

### 6.2 接口说明

#### support_ecm（只读）
```bash
cat /sys/class/hw_power/low_power/support_ecm
# 返回值：
# 0 = 不支持 ECM
# 1 = 支持 ECM
```

#### trigger_ecm（读写）
```bash
# 触发国内应急模式
echo 1 > /sys/class/hw_power/low_power/trigger_ecm

# 触发海外应急模式
echo 2 > /sys/class/hw_power/low_power/trigger_ecm

# 退出应急模式
echo 0 > /sys/class/hw_power/low_power/trigger_ecm

# 有效值：
# 0 = ECM_TRIGGER_IDLE（退出）
# 1 = ECM_TRIGGER_CN（国内）
# 2 = ECM_TRIGGER_OVERSEA（海外）
```

**触发效果**：
```c
case LPM_SYSFS_TRIGGER_ECM:
    l_dev->ecm.trigger_status = val;
    hwlog_info("set ecm trigger_status:%u\n", val);
    
    // 立即启动工作队列
    cancel_delayed_work_sync(&l_dev->lpm_work);
    power_wakeup_lock(l_dev->wakelock, false);
    mod_delayed_work(system_wq, &l_dev->lpm_work, msecs_to_jiffies(0));
    break;
```

#### gsm_ecm（读写）
```bash
# 设置 GSM 通话中
echo 1 > /sys/class/hw_power/low_power/gsm_ecm

# 设置 GSM 空闲
echo 0 > /sys/class/hw_power/low_power/gsm_ecm

# 有效值：
# 0 = ECM_GSM_IDLE（空闲）
# 1 = ECM_GSM_WORKING（通话中）
```

**作用**：
- GSM 通话中如果 VBAT < 3200mV，强制关机避免通话中断
- 由上层 Telephony 服务在通话开始/结束时设置

---

## 七、DTS 配置说明

### 7.1 完整配置示例
```
low_power {
    compatible = "huawei,low_power";
    status = "ok";
    
    /* Boost 类型：0=CHG_EN, 1=Q4, 2=NOOP */
    boost_type = <0>;
    
    /* VBUSIN 开关类型：0=TXSW, 1=GPIO */
    vbusin_pssw_type = <0>;
    
    /* Boost 模式额外功耗（mA） */
    icost_bst = <150>;
    
    /* Pinctrl 配置 */
    pinctrl_len = <1>;
    pinctrl-names = "default";
    pinctrl-0 = <&lpm_default>;
    
    /* GPIO 配置 */
    gpio_bst_vsys_sw = <&gpio25 3 0>;      // VSYS Boost 开关
    gpio_bst_chg_sw = <&gpio26 5 0>;       // 充电开关（仅 GPIO 模式）
    
    /* Buck-Boost 输出电压（进入/退出，mV） */
    lpm_bbst_vout = <3800 3600>;
    
    /* ECM 配置 */
    support_ecm = <1>;
    ecm_vbat_bst = <3100>;              // Boost 启动电压（mV）
    ecm_vbat_shutdown = <3050>;         // 关机电压（mV）
    ecm_vbat_gsm = <3200>;              // GSM 保护电压（mV）
    
    /* LTM 配置 */
    support_ltm = <1>;
    ltm_temp = <"-15">;                 // 温度阈值（°C）
    ltm_soc = <10>;                     // 电量阈值（%）
};
```

### 7.2 参数说明

| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| boost_type | u32 | 0 | Boost 控制方式<br>0=CHG_EN, 1=Q4, 2=NOOP |
| vbusin_pssw_type | u32 | 0 | VBUSIN 开关类型<br>0=TXSW, 1=GPIO |
| icost_bst | u32 | 150 | Boost 功耗补偿（mA） |
| gpio_bst_vsys_sw | GPIO | - | VSYS Boost 开关 GPIO |
| gpio_bst_chg_sw | GPIO | - | 充电开关 GPIO（GPIO 模式） |
| lpm_bbst_vout | u32[2] | - | Buck-Boost 电压（进入/退出，mV） |
| support_ecm | u32 | 0 | 是否支持 ECM（0=否, 1=是） |
| ecm_vbat_bst | u32 | 3100 | ECM Boost 启动电压（mV） |
| ecm_vbat_shutdown | u32 | 3050 | ECM 关机电压（mV） |
| ecm_vbat_gsm | u32 | 3200 | GSM 保护电压（mV） |
| support_ltm | u32 | 0 | 是否支持 LTM（0=否, 1=是） |
| ltm_temp | string | "-15" | LTM 温度阈值（°C） |
| ltm_soc | u32 | 10 | LTM 电量阈值（%） |

---

## 八、典型应用场景

### 8.1 场景1：极低电量应急通话（ECM）

```
用户场景：
电量显示 2%，用户需要拨打紧急电话

时序流程：
1. UI Capacity 降至 3%
   ↓
2. Framework 写入 trigger_ecm = 1（国内模式）
   ↓
3. lpm_work 启动（80ms 周期）
   ↓
4. 检测 VBAT = 3050mV < 3100mV（Boost 阈值）
   ↓
5. 检测 idischrg = 200mA > 150mA（电流阈值）
   ↓
6. 启动 Boost 升压：
   - 5V Boost ON
   - Buck-Boost 升压到 3.8V
   - VSYS 开关打开
   ↓
7. 系统电压稳定在 3.8V，支持 GSM 通话
   ↓
8. 通话过程中监控 VBAT：
   - 如果 VBAT < 3050mV（关机阈值）→ 上报欠压事件 → 强制关机
   - 如果 VBAT < 3200mV 且 GSM 通话中 → 强制关机
   ↓
9. 通话结束，用户插入充电器
   ↓
10. 检测到 plugin_status = true
    ↓
11. 关闭 Boost，退出 ECM，上报退出事件
```

**Uevent 上报**：
```bash
# 退出 ECM
BATTERY_EXIT_ECM=1

# 欠压强制关机
BATTERY_EXIT_ECM=2
```

### 8.2 场景2：低温环境提升放电性能（LTM）

```
用户场景：
户外 -20°C 环境，电量 8%，屏幕卡顿

时序流程：
1. 检测到 TBAT = -20°C, UI Capacity = 8%
   ↓
2. 触发 LTM 监控：ltm.monitor_type = WORKING
   ↓
3. lpm_work 启动（5s 周期）
   ↓
4. 检测放电电流 idischrg = 300mA > 150mA
   ↓
5. 启动 Boost 升压到 3.8V
   ↓
6. 系统电压提升，改善放电性能
   ↓
7. 温度回升到 5°C
   ↓
8. 检测 TBAT > 0°C（退出阈值）
   ↓
9. 关闭 Boost，退出 LTM 监控
```

### 8.3 场景3：无线反向充电冲突避让

```
用户场景：
ECM 模式中，用户尝试使用无线反向充电

时序流程：
1. ECM Boost 正在运行
   ↓
2. 用户将设备靠近接收器
   ↓
3. 无线 TX 检测到 Dping 信号
   ↓
4. 触发 POWER_NE_WLTX_RCV_DPING 事件
   ↓
5. low_power_wltx_dping_handler() 执行
   ↓
6. 立即关闭 Low Power Boost：
   - 关闭 VSYS 开关
   - 关闭 Buck-Boost
   - 关闭 5V Boost
   - 恢复充电通道
   ↓
7. 无线 TX 启动自己的 Boost
   ↓
8. 用户移开接收器，Dping 结束
   ↓
9. 重新评估 ECM 条件，可能再次启动 Boost
```

### 8.4 场景4：屏幕状态变化重评估

```
用户场景：
ECM 模式中，用户频繁开关屏幕

时序流程：
1. 屏幕关闭 → POWER_NE_PANEL_BLANK 事件
   ↓
2. 延迟 5s 后检测状态：
   - idischrg 降低（屏幕不耗电）
   - 可能关闭 Boost
   ↓
3. 屏幕打开 → POWER_NE_PANEL_UNBLANK 事件
   ↓
4. 延迟 5s 后检测状态：
   - idischrg 升高（屏幕耗电）
   - 可能启动 Boost
```

---

## 九、调试方法

### 9.1 日志关键点
```bash
# 1. ECM 触发日志
[low_power] set ecm trigger_status:1

# 2. LTM 触发日志
[low_power] triggered ltm monitor

# 3. 状态检测日志
[low_power] vbat=3050 shutdown_vol=3050 gsm_vol=3200 gsm_status=0
[low_power] ecm: trigger_status=1 bst=1, ltm: monitor_type=0 bst=0

# 4. 放电电流日志
[low_power] [check_idischarge] idischrg=250mA
[low_power] [set_idischrg_bst_th] en:>300mA, dis:<250mA

# 5. Boost 控制日志
[low_power] [boost_vsys_enable] enable:1, gpio_vsys_sw:1
[low_power] [vbusin_sw] gpio high now

# 6. 充电器插拔日志
[low_power] [vbus_plugged_handler] plugin_status:1

# 7. 屏幕状态日志
[low_power] [fb_notifier_call] fb screen off

# 8. 无线 TX Dping 日志
[low_power] wltx_dping_handler

# 9. 退出事件日志
[low_power] exit_ecm=1, report uevent
[low_power] exit_ecm=2, report uevent
```

### 9.2 Sysfs 调试
```bash
# 查看是否支持 ECM
cat /sys/class/hw_power/low_power/support_ecm

# 手动触发 ECM 测试
echo 1 > /sys/class/hw_power/low_power/trigger_ecm

# 模拟 GSM 通话
echo 1 > /sys/class/hw_power/low_power/gsm_ecm

# 查看 GPIO 状态
cat /sys/kernel/debug/gpio | grep bst_vsys_sw

# 查看 Buck-Boost 状态
cat /sys/kernel/debug/regulator/buck_boost/enable
cat /sys/kernel/debug/regulator/buck_boost/voltage
```

### 9.3 Power Debug 接口
```bash
# 手动控制 Boost（需要解锁值 0x29a）
echo "666 1" > /sys/kernel/debug/power/low_power/boost_vsys
# 格式：<unlock_val> <enable>
# unlock_val = 666（0x29a）
# enable: 0=关闭, 1=开启

# 查看当前 Boost 状态
cat /sys/kernel/debug/power/low_power/boost_vsys
# 输出：boost_vsys_status:1
```

### 9.4 常见问题排查

#### 问题1：ECM 未启动 Boost
**现象**：VBAT < 3.1V 但未启动 Boost

**排查步骤**：
1. 检查 ECM 触发状态：
   ```bash
   dmesg | grep "trigger_status"
   ```
2. 检查电流阈值：
   ```bash
   dmesg | grep "idischrg"
   # 如果 idischrg < 150mA，不会启动 Boost
   ```
3. 检查充电器状态：
   ```bash
   dmesg | grep "plugin_status"
   # 如果已插充电器，不会启动 Boost
   ```

#### 问题2：Boost 频繁开关
**现象**：日志显示 Boost 反复启动和关闭

**排查步骤**：
1. 检查电流滞回区间：
   ```bash
   dmesg | grep "set_idischrg_bst_th"
   # 应该有 50mA 的滞回区间
   ```
2. 检查 icost_bst 配置：
   ```bash
   cat /proc/device-tree/low_power/icost_bst
   # 默认应该是 150mA
   ```

#### 问题3：LTM 未启动
**现象**：低温低电量但未启动 LTM

**排查步骤**：
1. 检查 DTS 配置：
   ```bash
   cat /proc/device-tree/low_power/support_ltm
   cat /proc/device-tree/low_power/ltm_temp
   cat /proc/device-tree/low_power/ltm_soc
   ```
2. 检查温度读取：
   ```bash
   cat /sys/class/power_supply/battery/temp
   # 应该 < 0°C
   ```
3. 检查电量：
   ```bash
   cat /sys/class/power_supply/battery/capacity
   # 应该 ≤ 10%
   ```

#### 问题4：Boost 无法关闭
**现象**：插入充电器后 Boost 仍然运行

**排查步骤**：
1. 检查插拔事件：
   ```bash
   dmesg | grep "vbus_plugged_handler"
   ```
2. 检查工作队列：
   ```bash
   dmesg | grep "lpm_work"
   # 应该在充电器插入 50ms 后执行
   ```
3. 手动关闭 Boost：
   ```bash
   echo 0 > /sys/class/hw_power/low_power/trigger_ecm
   ```

---

## 十、总结

### 10.1 技术特点
1. **双模式支持**：ECM（应急）+ LTM（低温）两种场景覆盖
2. **多维度判断**：电压、电流、温度、电量四维条件综合评估
3. **智能滞回**：防止 Boost 频繁开关，延长硬件寿命
4. **安全退出**：充电器插入、电压恢复、温度上升等多种退出机制

### 10.2 设计亮点
- **80ms 快速响应**：ECM 模式下高频轮询，及时响应电压跌落
- **GSM 通话保护**：专门针对 2G 网络通话场景的电压保护
- **无线冲突避让**：主动让出 Boost 资源给无线反向充电
- **动态阈值调整**：Boost 功耗自动补偿，精确控制启停条件

### 10.3 应用价值
- **延长应急时间**：极低电量下额外 5-10 分钟可用时间
- **保障通讯功能**：确保关机前能拨打紧急电话
- **改善低温性能**：低温环境下提升放电效率 20-30%
- **用户体验优化**：避免"有电但无法使用"的尴尬场景

### 10.4 适用场景
- **极低电量应急**：1%-3% 电量时的紧急通讯
- **低温户外使用**：-15°C ~ 0°C 环境的性能保障
- **老化电池保护**：内阻升高电池的电压维持
- **2G 网络覆盖区**：GSM 通话的特殊电压需求
