---
outline: deep
---

# dischg_boost 模块分析

## 1. 模块定位与核心价值

`dischg_boost` 是华为充电框架中的**放电路径升压切换模块**（Discharge Boost Switch），用于在低电量场景下**动态切换系统供电路径**，优化放电性能和系统稳定性。

### 核心特性

- **基于 SOC 的智能切换**：根据电池电量（SOC）自动切换供电路径
- **双 GPIO 控制**：通过两个 GPIO 控制 Normal 和 Boost 两种模式
- **迟滞区间设计**：设置 PENDING 缓冲区，避免频繁切换
- **状态机管理**：基于场景（Scene）的状态转换机制
- **唤醒锁保护**：切换过程持有唤醒锁，防止系统休眠

### 应用背景

在低电量场景（通常 <20% SOC），系统需要**从电池直供切换到升压供电**，以：
1. **提升电压稳定性**：低电量时电池电压下降，升压后提供稳定 VSYS
2. **防止意外关机**：升压模式下可以从更低电压的电池中取电
3. **优化放电曲线**：延长设备使用时间

---

## 2. 系统架构

### 2.1 硬件拓扑图

```
┌─────────────────────────────────────────────────────────────────┐
│                   电池管理系统 (SOC监控)                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ Power Supply Notifier Chain                            │    │
│  │  - 监控电池 SOC 变化                                   │    │
│  │  - 触发 dischg_boost_psy_change_cb()                   │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ↓ SOC 变化通知
┌─────────────────────────────────────────────────────────────────┐
│                  dischg_boost 模块                               │
│                 (放电路径切换控制器)                             │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ 场景判断逻辑 (Scene Decision)                          │    │
│  │                                                        │    │
│  │  SOC > switch_normal_soc (25%)                         │    │
│  │      → VSYS_SWITCH_SCENE_NORMAL (正常模式)             │    │
│  │                                                        │    │
│  │  switch_boost_soc < SOC ≤ switch_normal_soc           │    │
│  │      → VSYS_SWITCH_SCENE_PENDING (缓冲区)              │    │
│  │                                                        │    │
│  │  SOC ≤ switch_boost_soc (20%)                          │    │
│  │      → VSYS_SWITCH_SCENE_BOOST (升压模式)              │    │
│  └────────────────────────────────────────────────────────┘    │
│                              ↓                                   │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ 状态转换处理器 (Switch Handler)                        │    │
│  │                                                        │    │
│  │  NORMAL/PENDING → BOOST:                               │    │
│  │    dischg_boost_switch_to_boost()                      │    │
│  │                                                        │    │
│  │  BOOST/PENDING → NORMAL:                               │    │
│  │    dischg_boost_switch_to_normal()                     │    │
│  └────────────────────────────────────────────────────────┘    │
│                              ↓                                   │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ GPIO 控制层                                            │    │
│  │  • normal_gpio: 控制正常供电路径                       │    │
│  │  • boost_gpio:  控制升压供电路径                       │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ↓ GPIO 信号
┌─────────────────────────────────────────────────────────────────┐
│              硬件层 (电源路径切换电路)                           │
│                                                                  │
│  ┌──────────────────────┐         ┌──────────────────────┐    │
│  │   正常放电路径        │         │   升压放电路径        │    │
│  │   (Normal Path)      │         │   (Boost Path)       │    │
│  │                      │         │                      │    │
│  │  Battery → VSYS      │         │  Battery → Boost     │    │
│  │  (直连，高效)        │         │  Converter → VSYS    │    │
│  │                      │         │  (升压，低效)        │    │
│  │  normal_gpio = 1     │         │  boost_gpio = 1      │    │
│  │  boost_gpio = 0      │         │  normal_gpio = 0     │    │
│  └──────────────────────┘         └──────────────────────┘    │
│                                                                  │
│           互斥切换（同时只能一个路径有效）                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    ┌──────────────────┐
                    │   VSYS (系统电源) │
                    └──────────────────┘
```

### 2.2 状态转换图

```
                     SOC 变化驱动状态转换

        ┌─────────────────────────────────────────────┐
        │                                             │
        ▼                                             │
┌───────────────┐                            ┌────────────────┐
│               │  SOC ≤ 20%                 │                │
│    NORMAL     │ ──────────────────────────▶│     BOOST      │
│   正常模式     │  (switch_to_boost)         │    升压模式     │
│               │                            │                │
│ normal_gpio=1 │                            │ boost_gpio=1   │
│ boost_gpio=0  │                            │ normal_gpio=0  │
└───────────────┘                            └────────────────┘
        ▲                                             │
        │  SOC > 25%                                  │
        │  (switch_to_normal)                         │
        │                                             │
        └─────────────────────────────────────────────┘

                    ┌──────────────┐
                    │   PENDING    │
                    │   缓冲区      │
                    │ 20% < SOC    │
                    │     ≤ 25%    │
                    └──────────────┘
                         │
                         │ 不触发切换
                         ▼
                    (保持当前状态)

关键参数（可配置）：
- switch_boost_soc:  20%  (进入 Boost 阈值)
- switch_normal_soc: 25%  (退出 Boost 阈值)
- 迟滞区间: 5%（防止频繁切换）
```

### 2.3 时序图

#### 场景1: 放电过程（NORMAL → BOOST）

```
SOC: 30% → 25% → 20% → 15%

时刻 T0: SOC = 30%
    场景 = NORMAL
    normal_gpio = 1, boost_gpio = 0
    电池直连 VSYS

时刻 T1: SOC = 25% (等于 switch_normal_soc)
    场景 = PENDING (进入缓冲区)
    保持当前状态，不触发切换
    
时刻 T2: SOC = 20% (等于 switch_boost_soc)
    场景 = BOOST (触发切换)
    ↓
    dischg_boost_trigger_switch()
    ↓
    schedule_work(&switch_work)
    ↓
    dischg_boost_work()
    ↓
    dischg_boost_switch_to_boost()
    ↓ 持有唤醒锁
    Step 1: normal_gpio = 0 (断开正常路径)
    ↓ 延迟 1ms (switch_boost_delay_ms)
    Step 2: boost_gpio = 1 (接通升压路径)
    ↓ 释放唤醒锁
    
时刻 T3: 切换完成
    场景 = BOOST
    normal_gpio = 0, boost_gpio = 1
    电池 → Boost Converter → VSYS
```

#### 场景2: 充电过程（BOOST → NORMAL）

```
SOC: 15% → 20% → 25% → 30%

时刻 T0: SOC = 15%
    场景 = BOOST
    normal_gpio = 0, boost_gpio = 1
    升压供电

时刻 T1: SOC = 20%
    场景 = PENDING (进入缓冲区)
    保持 BOOST 状态，不触发切换
    
时刻 T2: SOC = 25% (超过 switch_normal_soc)
    场景 = NORMAL (触发切换)
    ↓
    dischg_boost_trigger_switch()
    ↓
    schedule_work(&switch_work)
    ↓
    dischg_boost_work()
    ↓
    dischg_boost_switch_to_normal()
    ↓ 持有唤醒锁
    Step 1: boost_gpio = 0 (断开升压路径)
    ↓ 延迟 4ms (switch_normal_delay_ms)
    Step 2: normal_gpio = 1 (接通正常路径)
    ↓ 释放唤醒锁
    
时刻 T3: 切换完成
    场景 = NORMAL
    normal_gpio = 1, boost_gpio = 0
    电池直连 VSYS
```

---

## 3. 核心数据结构

### 3.1 配置结构体

```c
struct dischg_boost_config {
    int switch_boost_soc;         // 进入 Boost 模式的 SOC 阈值（默认 20%）
    int switch_normal_soc;        // 退出 Boost 模式的 SOC 阈值（默认 25%）
    int switch_boost_delay_ms;    // 切换到 Boost 的延迟（默认 1ms）
    int switch_normal_delay_ms;   // 切换到 Normal 的延迟（默认 4ms）
    int boost_gpio;               // Boost 路径控制 GPIO
    int normal_gpio;              // Normal 路径控制 GPIO
};
```

**字段说明**：
- **迟滞区间**：`switch_normal_soc - switch_boost_soc = 5%`，防止在阈值附近频繁切换
- **延迟时间**：切换时序控制，避免两路同时导通（可能短路）或同时断开（VSYS 掉电）

### 3.2 设备结构体

```c
struct dischg_boost_dev {
    struct device *dev;                   // 设备指针
    struct wakeup_source *wakelock;       // 唤醒锁（切换时防休眠）
    struct work_struct switch_work;       // 切换工作队列
    struct notifier_block soc_change_nb;  // SOC 变化通知块
    struct dischg_boost_config dischg_cfg;// 配置参数
    atomic_t prev_scene;                  // 前一个场景状态（原子变量）
};
```

### 3.3 场景定义

```c
/* 场景标志位（可组合） */
#define VSYS_SWITCH_SCENE_NORMAL  0x1  // 正常模式
#define VSYS_SWITCH_SCENE_BOOST   0x2  // 升压模式
#define VSYS_SWITCH_SCENE_PENDING 0x4  // 缓冲区（迟滞区间）
```

**场景映射**：
```c
static inline int dischg_boost_get_scene_by_soc(
    const struct dischg_boost_config *cfg, int soc)
{
    if (soc <= cfg->switch_boost_soc)        // SOC ≤ 20%
        return VSYS_SWITCH_SCENE_BOOST;
    else if (soc > cfg->switch_normal_soc)   // SOC > 25%
        return VSYS_SWITCH_SCENE_NORMAL;
    else                                      // 20% < SOC ≤ 25%
        return VSYS_SWITCH_SCENE_PENDING;
}
```

### 3.4 切换条件与处理器映射

```c
/* 切换条件 */
struct switch_cond {
    int prev_scene;  // 前一个场景（可以是组合标志）
    int next_scene;  // 下一个场景
};

/* 切换处理器项 */
struct switch_item {
    struct switch_cond cond;      // 匹配条件
    switch_handler handler;       // 处理函数
};

/* 处理器映射表 */
static const struct switch_item handler_map[] = {
    {
        .cond = {
            .prev_scene = VSYS_SWITCH_SCENE_BOOST | VSYS_SWITCH_SCENE_PENDING,
            .next_scene = VSYS_SWITCH_SCENE_NORMAL,
        },
        .handler = dischg_boost_switch_to_normal,  // BOOST/PENDING → NORMAL
    },
    {
        .cond = {
            .prev_scene = VSYS_SWITCH_SCENE_NORMAL | VSYS_SWITCH_SCENE_PENDING,
            .next_scene = VSYS_SWITCH_SCENE_BOOST,
        },
        .handler = dischg_boost_switch_to_boost,   // NORMAL/PENDING → BOOST
    },
};
```

**匹配逻辑**：
- 使用位运算判断场景是否匹配
- `prev_scene` 使用 OR 组合，表示可以从多个状态转换
- 例如：`BOOST | PENDING` 表示从 BOOST 或 PENDING 都可以转到 NORMAL

---

## 4. 核心功能实现

### 4.1 切换到升压模式

```c
static int dischg_boost_switch_to_boost(struct dischg_boost_dev *di)
{
    hwlog_info("switch_to_boost begin\n");
    
    // 持有唤醒锁，防止切换过程系统休眠
    power_wakeup_lock(di->wakelock, false);
    
    // Step 1: 断开正常路径
    gpio_direction_output(di->dischg_cfg.normal_gpio, 0);
    
    // Step 2: 等待延迟（确保正常路径完全断开）
    power_usleep(di->dischg_cfg.switch_boost_delay_ms * DT_USLEEP_1MS);
    
    // Step 3: 接通升压路径
    gpio_direction_output(di->dischg_cfg.boost_gpio, 1);
    
    // 释放唤醒锁
    power_wakeup_unlock(di->wakelock, false);
    
    hwlog_info("switch_to_boost end\n");
    return 0;
}
```

**关键设计**：
1. **先断后通**：先断开 normal_gpio，再打开 boost_gpio
2. **延迟保护**：两步之间延迟 1ms（默认），避免瞬间短路或掉电
3. **唤醒锁**：整个切换过程持有锁，防止系统休眠导致切换失败

### 4.2 切换到正常模式

```c
static int dischg_boost_switch_to_normal(struct dischg_boost_dev *di)
{
    hwlog_info("switch_to_normal begin\n");
    
    // 持有唤醒锁
    power_wakeup_lock(di->wakelock, false);
    
    // Step 1: 断开升压路径
    gpio_direction_output(di->dischg_cfg.boost_gpio, 0);
    
    // Step 2: 等待延迟（确保升压路径完全断开）
    power_usleep(di->dischg_cfg.switch_normal_delay_ms * DT_USLEEP_1MS);
    
    // Step 3: 接通正常路径
    gpio_direction_output(di->dischg_cfg.normal_gpio, 1);
    
    // 释放唤醒锁
    power_wakeup_unlock(di->wakelock, false);
    
    hwlog_info("switch_to_normal end\n");
    return 0;
}
```

**延迟差异**：
- `switch_boost_delay_ms = 1ms`：切换到 Boost 延迟短（低电量紧急场景）
- `switch_normal_delay_ms = 4ms`：切换到 Normal 延迟长（确保升压电路完全放电）

### 4.3 SOC 变化监听与触发

```c
static int dischg_boost_psy_change_cb(
    struct notifier_block *nb, unsigned long event, void *data)
{
    struct dischg_boost_dev *di = NULL;
    struct power_supply *psy = data;

    if (!nb || !data) {
        hwlog_err("nb or data is null\n");
        return NOTIFY_OK;
    }

    di = container_of(nb, struct dischg_boost_dev, soc_change_nb);
    if (!di) {
        hwlog_err("di is null\n");
        return NOTIFY_OK;
    }

    // 只关心 "Battery" power_supply 的变化
    if (strcmp(psy->desc->name, PSY_NAME)) {
        hwlog_info("psy %s is not target, ignore\n", PSY_NAME);
        return NOTIFY_OK;
    }

    // 触发切换检查
    dischg_boost_trigger_switch(di);
    return NOTIFY_OK;
}
```

**触发逻辑**：
```c
static void dischg_boost_trigger_switch(struct dischg_boost_dev *di)
{
    int cur_scene;
    struct switch_cond cur_cond = { 0 };
    int prev_scene = atomic_read(&di->prev_scene);

    // 获取当前场景
    cur_scene = dischg_boost_get_current_scene(&di->dischg_cfg);
    
    // 场景未变化，不触发
    if (prev_scene == cur_scene)
        return;

    cur_cond.next_scene = cur_scene;
    cur_cond.prev_scene = prev_scene;

    // 检查是否有对应的切换处理器
    if (!dischg_boost_has_switch_handler(&cur_cond))
        return;

    // 避免重复调度（工作队列已在执行）
    if (work_busy(&di->switch_work)) {
        hwlog_info("switch work was just triggered, ignore\n");
        return;
    }

    // 调度切换工作
    hwlog_info("trigger switch work\n");
    schedule_work(&di->switch_work);
}
```

### 4.4 切换工作队列

```c
static void dischg_boost_work(struct work_struct *work)
{
    int current_scene;
    int previous_scene;
    struct dischg_boost_dev *di = NULL;
    switch_handler handler = NULL;
    struct switch_cond cur_cond = { 0 };

    if (!work) {
        hwlog_err("work is null\n");
        return;
    }

    di = container_of(work, struct dischg_boost_dev, switch_work);
    if (!di) {
        hwlog_err("di is null\n");
        return;
    }

    // 读取前一个场景
    previous_scene = atomic_read(&di->prev_scene);
    
    // 获取当前场景（重新读取，因为可能已变化）
    current_scene = dischg_boost_get_current_scene(&di->dischg_cfg);
    
    // 场景未变化，不执行
    if (current_scene == previous_scene) {
        hwlog_err("scene:%d has not been changed\n", current_scene);
        return;
    }

    // 构造切换条件
    cur_cond.next_scene = current_scene;
    cur_cond.prev_scene = previous_scene;
    
    // 获取对应的处理器
    handler = dischg_boost_get_switch_handler(&cur_cond);
    if (!handler) {
        hwlog_err("handler is null\n");
        return;
    }

    // 执行切换
    hwlog_info("dischg_boost_work execute handler\n");
    handler(di);
    
    // 更新场景状态
    atomic_set(&di->prev_scene, current_scene);
}
```

---

## 5. 典型应用场景

### 5.1 低电量放电场景

```
用户场景：手机从 50% 电量放电到 10%

SOC: 50% → 30% → 25% → 20% → 15% → 10%
     ↓      ↓      ↓      ↓      ↓      ↓
场景: NORMAL NORMAL PENDING BOOST  BOOST  BOOST

时间线：
T0 (SOC=50%): 正常模式，电池直连 VSYS
              normal_gpio=1, boost_gpio=0

T1 (SOC=30%): 仍为正常模式，无变化

T2 (SOC=25%): 进入 PENDING 缓冲区
              场景改变但不触发切换（没有对应的 handler）
              保持正常模式

T3 (SOC=20%): 触发切换到 BOOST 模式
              dischg_boost_psy_change_cb() 被调用
              ↓
              schedule_work(&switch_work)
              ↓
              dischg_boost_switch_to_boost()
              ├─ normal_gpio = 0
              ├─ 延迟 1ms
              └─ boost_gpio = 1
              
              系统切换到升压供电
              normal_gpio=0, boost_gpio=1

T4 (SOC=15%): 保持 BOOST 模式

T5 (SOC=10%): 保持 BOOST 模式，直到充电
```

### 5.2 充电恢复场景

```
用户场景：手机从 10% 充电到 30%

SOC: 10% → 15% → 20% → 25% → 30%
     ↓      ↓      ↓      ↓      ↓
场景: BOOST  BOOST  PENDING NORMAL NORMAL

时间线：
T0 (SOC=10%): 升压模式，Boost Converter 供电
              normal_gpio=0, boost_gpio=1

T1 (SOC=15%): 仍为升压模式，无变化

T2 (SOC=20%): 进入 PENDING 缓冲区
              场景改变但不触发切换
              保持升压模式

T3 (SOC=25%): 触发切换到 NORMAL 模式
              dischg_boost_psy_change_cb() 被调用
              ↓
              schedule_work(&switch_work)
              ↓
              dischg_boost_switch_to_normal()
              ├─ boost_gpio = 0
              ├─ 延迟 4ms
              └─ normal_gpio = 1
              
              系统切换到正常供电
              normal_gpio=1, boost_gpio=0

T4 (SOC=30%): 保持 NORMAL 模式
```

### 5.3 系统休眠唤醒场景

```
场景：系统休眠期间 SOC 从 22% 降到 18%

休眠前（SOC=22%）:
    场景 = PENDING
    normal_gpio=1, boost_gpio=0 (保持正常模式)

休眠中：
    SOC 缓慢下降到 18%
    Power Supply 通知链被冻结，回调不触发

系统唤醒：
    dischg_boost_resume() 被调用
    ↓
    dischg_boost_trigger_switch()
    ↓
    重新读取 SOC = 18%
    ↓
    场景 = BOOST (从 PENDING 变为 BOOST)
    ↓
    schedule_work(&switch_work)
    ↓
    执行切换到升压模式
```

---

## 6. 调试接口

### 6.1 debugfs 接口

模块提供了丰富的调试接口（需要 `CONFIG_HUAWEI_POWER_DEBUG`）：

```bash
# 1. 查看场景判断逻辑
echo "15" > /sys/kernel/debug/hwpower/dischg_boost/get_scene
# 输出: soc=15, scene=2 (BOOST)

echo "30" > /sys/kernel/debug/hwpower/dischg_boost/get_scene
# 输出: soc=30, scene=1 (NORMAL)

# 2. 手动触发切换（模拟 SOC 变化）
echo "30 15" > /sys/kernel/debug/hwpower/dischg_boost/exec_handler
# 解释: prev_soc=30, next_soc=15
# 输出: prev_soc=30, prev_scene=1, next_soc=15, next_scene=2
#       执行 dischg_boost_switch_to_boost()

# 3. 查看/修改 SOC 配置
cat /sys/kernel/debug/hwpower/dischg_boost/dischg_soc_cfg
# 输出: boost_soc=20, normal_soc=25

echo "15 30" > /sys/kernel/debug/hwpower/dischg_boost/dischg_soc_cfg
# 设置: boost_soc=15, normal_soc=30（扩大迟滞区间到 15%）

# 4. 查看/修改切换延迟
cat /sys/kernel/debug/hwpower/dischg_boost/switch_delay_ms
# 输出: boost_delay_ms=1, normal_delay_ms=4

echo "2 10" > /sys/kernel/debug/hwpower/dischg_boost/switch_delay_ms
# 设置: boost_delay_ms=2, normal_delay_ms=10
```

### 6.2 日志追踪

```bash
# 使能日志
echo 8 > /proc/sys/kernel/printk

# 过滤 dischg_boost 日志
dmesg | grep dischg_boost

# 典型日志输出
[  xxx.xxx] dischg_boost: trigger switch work
[  xxx.xxx] dischg_boost: dischg_boost_work execute handler
[  xxx.xxx] dischg_boost: switch_to_boost begin
[  xxx.xxx] dischg_boost: switch_to_boost end
[  xxx.xxx] dischg_boost: prev_soc=30, prev_scene=1, next_soc=15, next_scene=2
```

### 6.3 GPIO 状态验证

```bash
# 查看 GPIO 状态
cat /sys/kernel/debug/gpio | grep dischg

# 输出示例（正常模式）
gpio-123 (dischg_normal_gpio) out hi
gpio-124 (dischg_boost_gpio ) out lo

# 输出示例（升压模式）
gpio-123 (dischg_normal_gpio) out lo
gpio-124 (dischg_boost_gpio ) out hi
```

---

## 7. 设计特点与优势

### 7.1 迟滞区间设计（Hysteresis）

```
         switch_normal_soc (25%)
                │
    ┌───────────┼───────────┐
    │           │           │
    │  NORMAL   │  PENDING  │  BOOST
    │           │           │
    └───────────┼───────────┘
                │
         switch_boost_soc (20%)

迟滞区间 = 5%
```

**优势**：
- ✅ 防止抖动：在阈值附近 SOC 波动时不会频繁切换
- ✅ 稳定性：切换次数减少，延长硬件寿命
- ✅ 电源平滑：避免频繁切换导致的电压尖峰

**示例**：
```
无迟滞（错误设计）:
SOC: 20.5% → 19.5% → 20.5% → 19.5%
     NORMAL   BOOST   NORMAL   BOOST  ← 频繁切换！

有迟滞（正确设计）:
SOC: 20.5% → 19.5% → 20.5% → 24.5% → 25.5%
     NORMAL   BOOST   BOOST   BOOST   NORMAL  ← 稳定切换
```

### 7.2 唤醒锁保护

```c
power_wakeup_lock(di->wakelock, false);   // 持有锁
gpio_direction_output(...);
power_usleep(...);
gpio_direction_output(...);
power_wakeup_unlock(di->wakelock, false); // 释放锁
```

**作用**：
- ✅ 防止切换过程中系统进入休眠
- ✅ 确保 GPIO 操作原子性
- ✅ 避免切换不完整导致的供电异常

### 7.3 工作队列异步处理

```c
// 在中断上下文中快速返回
static int dischg_boost_psy_change_cb(...)
{
    // 不直接切换，而是调度工作队列
    schedule_work(&di->switch_work);
    return NOTIFY_OK;  // 快速返回
}

// 在工作队列中执行耗时操作
static void dischg_boost_work(struct work_struct *work)
{
    // 可以睡眠、延迟等
    handler(di);
}
```

**优势**：
- ✅ 快速响应：通知回调快速返回，不阻塞其他通知
- ✅ 允许睡眠：工作队列可以使用 `usleep`
- ✅ 防重入：`work_busy()` 检测避免重复调度

### 7.4 原子变量保护

```c
atomic_t prev_scene;  // 使用原子变量存储状态

// 读取
int prev_scene = atomic_read(&di->prev_scene);

// 更新
atomic_set(&di->prev_scene, current_scene);
```

**作用**：
- ✅ 无锁并发安全
- ✅ 避免状态不一致
- ✅ 高效的读写操作

---

## 8. 潜在问题与改进建议

### 8.1 切换延迟优化

**当前问题**：
- `switch_boost_delay_ms = 1ms` 可能过短，硬件电路可能未完全断开
- `switch_normal_delay_ms = 4ms` 可能过长，导致瞬间掉电

**改进建议**：
```c
static int dischg_boost_switch_to_boost(struct dischg_boost_dev *di)
{
    power_wakeup_lock(di->wakelock, false);
    
    // Step 1: 断开正常路径
    gpio_direction_output(di->dischg_cfg.normal_gpio, 0);
    
    // Step 2: 读取 VSYS 电压，确保已降到安全值
    int retry = 0;
    int vsys = 0;
    while (retry++ < 10) {
        read_vsys_voltage(&vsys);
        if (vsys < SAFE_VSYS_THRESHOLD)
            break;
        usleep_range(100, 150); // 100us
    }
    
    // Step 3: 接通升压路径
    gpio_direction_output(di->dischg_cfg.boost_gpio, 1);
    
    power_wakeup_unlock(di->wakelock, false);
    return 0;
}
```

### 8.2 状态机完整性

**当前问题**：
- PENDING 状态没有对应的处理逻辑
- 只有 NORMAL ↔ BOOST 的切换，PENDING 只是通过标志

**改进建议**：
```c
// 明确定义状态转换规则
enum vsys_switch_scene {
    SCENE_NORMAL,
    SCENE_PENDING,
    SCENE_BOOST,
};

static const struct switch_item handler_map[] = {
    { .cond = { SCENE_NORMAL,  SCENE_PENDING }, .handler = NULL },  // 不切换
    { .cond = { SCENE_PENDING, SCENE_BOOST   }, .handler = switch_to_boost },
    { .cond = { SCENE_BOOST,   SCENE_PENDING }, .handler = NULL },  // 不切换
    { .cond = { SCENE_PENDING, SCENE_NORMAL  }, .handler = switch_to_normal },
};
```

### 8.3 异常恢复机制

**当前问题**：
- GPIO 切换失败后无检测和恢复机制
- 可能导致两路都关闭或都开启

**改进建议**：
```c
static int dischg_boost_switch_to_boost(struct dischg_boost_dev *di)
{
    int ret;
    
    power_wakeup_lock(di->wakelock, false);
    
    // 切换前检查
    if (gpio_get_value(di->dischg_cfg.boost_gpio) == 1) {
        hwlog_err("boost_gpio already high, abnormal state\n");
        goto fail;
    }
    
    gpio_direction_output(di->dischg_cfg.normal_gpio, 0);
    power_usleep(di->dischg_cfg.switch_boost_delay_ms * DT_USLEEP_1MS);
    gpio_direction_output(di->dischg_cfg.boost_gpio, 1);
    
    // 切换后验证
    if (gpio_get_value(di->dischg_cfg.boost_gpio) != 1 ||
        gpio_get_value(di->dischg_cfg.normal_gpio) != 0) {
        hwlog_err("GPIO state mismatch after switch\n");
        goto fail_recovery;
    }
    
    power_wakeup_unlock(di->wakelock, false);
    return 0;

fail_recovery:
    // 恢复到安全状态（正常模式）
    gpio_direction_output(di->dischg_cfg.boost_gpio, 0);
    power_usleep(4 * DT_USLEEP_1MS);
    gpio_direction_output(di->dischg_cfg.normal_gpio, 1);
    
fail:
    power_wakeup_unlock(di->wakelock, false);
    return -EIO;
}
```

---

## 9. 设备树配置示例

```dts
dischg_boost {
    compatible = "huawei,dischg_boost";
    status = "ok";
    
    /* SOC 阈值配置 */
    switch_boost_soc = <20>;   // 进入升压模式的 SOC（%）
    switch_normal_soc = <25>;  // 退出升压模式的 SOC（%）
    
    /* 切换延迟配置 */
    switch_boost_delay_ms = <1>;  // 切换到升压的延迟（ms）
    switch_normal_delay_ms = <4>; // 切换到正常的延迟（ms）
    
    /* GPIO 配置 */
    normal_gpio = <&gpio15 2 0>;  // 正常路径控制 GPIO
    boost_gpio = <&gpio15 3 0>;   // 升压路径控制 GPIO
};
```

**配置调优建议**：

| 场景 | boost_soc | normal_soc | 迟滞区间 | 说明 |
|------|-----------|------------|----------|------|
| 激进策略 | 25% | 30% | 5% | 更早进入升压，延长使用时间 |
| 默认策略 | 20% | 25% | 5% | 平衡性能和切换频率 |
| 保守策略 | 15% | 20% | 5% | 减少升压使用（升压效率低）|
| 大迟滞 | 15% | 30% | 15% | 减少切换次数，牺牲响应速度 |

---

## 10. 性能分析

### 10.1 功耗影响

**正常模式（Normal Path）**：
- 电池 → VSYS 直连
- 效率：~98%
- 功耗：最低

**升压模式（Boost Path）**：
- 电池 → Boost Converter → VSYS
- 效率：~85-90%
- 功耗：增加 10-15%

**切换开销**：
- GPIO 操作：< 1μs
- 延迟等待：1-4ms
- 唤醒锁持有：5-10ms
- 工作队列调度：< 100μs

### 10.2 切换频率分析

**典型场景**：
```
正常使用（1C 放电率）：
    100% → 20%  大约 3-4 小时
    切换次数：1 次（从 NORMAL 到 BOOST）

充电（1C 充电率）：
    20% → 100%  大约 1 小时
    切换次数：1 次（从 BOOST 到NORMAL）

每天切换次数：< 5 次（典型）
```

**极端场景**（在阈值附近反复充放电）：
```
无迟滞：每分钟可能切换数十次 ❌
有迟滞：切换稳定，5% 区间内不切换 ✓
```

---

## 11. 总结

### 11.1 核心价值

`dischg_boost` 模块是华为充电框架中的**智能供电路径管理器**，通过监控电池 SOC 自动切换放电路径，实现：

1. **延长续航**：低电量时启用升压，从更低电压取电
2. **提升稳定性**：避免低电压导致的系统不稳定
3. **优化效率**：高电量时使用直连，低功耗高效率

### 11.2 技术亮点

| 特性 | 实现 | 优势 |
|------|------|------|
| 迟滞区间 | 5% SOC 缓冲区 | 防止频繁切换 |
| 唤醒锁 | 切换时持有 | 保证操作完整性 |
| 异步工作队列 | schedule_work | 快速响应，允许睡眠 |
| 原子变量 | atomic_t | 无锁并发安全 |
| 可配置参数 | DTS + debugfs | 灵活调优 |
| 先断后通 | GPIO 时序控制 | 避免短路/掉电 |

### 11.3 适用场景

✅ **适合**：
- 低电量场景需要升压支持
- 电池电压范围大（3.0V - 4.4V）
- 对续航有极致要求

❌ **不适合**：
- 全程高压供电的设备
- 无升压电路的硬件
- 对切换延迟敏感的场景

### 11.4 与其他模块对比

| 模块 | 功能 | 切换对象 | 触发条件 |
|------|------|----------|----------|
| charger_channel | 充电通道切换 | USB/无线输入 | 充电模式变化 |
| **dischg_boost** | **放电路径切换** | **直连/升压** | **SOC 变化** |
| vbus_channel | VBUS 通道切换 | 主/辅 VBUS | 充电策略 |

---

## 12. 参考资料

- dischg_boost.c
- dischg_boost.h
- Power Supply Notifier Chain 机制
- GPIO 子系统文档
