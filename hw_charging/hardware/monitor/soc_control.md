---
outline: deep
---

# SOC Control 模块分析

## 一、模块概述

### 1.1 功能定位
**SOC Control (State of Charge Control，电量控制)** 是华为 MATE X5 电源管理系统中的**电池电量控制模块**，主要用于将电池电量限制在特定范围内（如 55%-75%），通过控制充电使能和输入电流限制，防止电池长期处于高电量状态，从而**延长电池循环寿命**。

### 1.2 核心功能
- **电量范围控制**：设置电池电量上下限（如 min_soc=55%, max_soc=75%）
- **充电智能控制**：超过上限时禁用充电，低于下限时启用充电
- **电流动态调节**：禁充时限流 100mA 供系统运行，启充时恢复正常电流
- **双策略支持**：
  - **Class A 策略**：电量在范围内波动（55%-75% 之间上下浮动）
  - **Class B 策略**：电量保持在上限（恰好维持在 75%）
- **多用户管理**：支持 RC、HIDL、Shell、Demo 等多种操作来源
- **投票机制**：通过 Power Vote 实现多模块协同控制

### 1.3 设计背景
**电池寿命与充电状态的关系**：
- 电池长期处于高电量（> 80%）会加速老化
- 电池长期处于满电（100%）会显著降低循环寿命
- 最佳存储电量为 40%-60%
- 将日常使用电量控制在 55%-75% 可延长寿命 30%-50%

**应用场景**：
- **展示机/Demo 机**：长期插电展示，需控制电量避免过充
- **工作站模式**：设备当作工作站长期连接电源使用
- **电池健康保护**：用户主动开启电池保护模式
- **仓储/测试**：设备长期存储或测试时的电量维护

---

## 二、系统架构

### 2.1 模块组成
```
soc_control 模块
├── soc_control.c       # 主逻辑（电量监控、充电控制）
├── soc_control.h       # 数据结构定义
├── Kconfig             # 内核配置
└── Makefile            # 编译配置
```

### 2.2 架构分层
```
+---------------------------------------------------------------+
|                    User Space (Sysfs/HIDL)                    |
|  /sys/class/hw_power/soc_control/                             |
|    ├─ control (读写): 设置使能和电量范围                        |
|    └─ strategy (读写): 选择控制策略                             |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Power Vote System (投票机制)                      |
|  soc_ctrl_h (上限投票):                                        |
|    - 多个用户投票选择 max_soc                                   |
|    - 取最小值作为最终上限                                       |
|  soc_ctrl_l (下限投票):                                        |
|    - 多个用户投票选择 min_soc                                   |
|    - 取最小值作为最终下限                                       |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              SOC Control Core (soc_control.c)                 |
|  状态机:                                                       |
|    - WORK_IN_DEFAULT_MODE: 正常模式                           |
|    - WORK_IN_ENABLE_CHG_MODE: 启用充电                        |
|    - WORK_IN_DISABLE_CHG_MODE: 禁用充电                       |
|    - WORK_IN_BALANCE_MODE: 平衡模式（Class B）                |
|                                                               |
|  控制策略:                                                     |
|    - Class A: 波动策略（55%-75% 之间波动）                     |
|    - Class B: 保持策略（恰好维持在 75%）                       |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Charger Interface (power_if)                     |
|  - POWER_IF_SYSFS_ENABLE_CHARGER: 充电使能控制                |
|  - POWER_IF_SYSFS_VBUS_IIN_LIMIT: 输入电流限制                |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Hardware Layer (Charger IC)                      |
|  - 充电使能/禁用开关                                            |
|  - 输入电流限制寄存器                                           |
+---------------------------------------------------------------+
```

### 2.3 工作流程
```
充电器插入
    ↓
POWER_NE_CHARGING_START 事件触发
    ↓
延迟 5 秒启动（等待系统稳定）
    ↓
soc_ctrl_event_work() 周期执行（30s 一次）
    ↓
┌─────────────────────────────────────────────────┐
│  读取当前电量 (cur_soc)                          │
│                                                 │
│  判断电量与范围关系:                              │
│  ┌─────────────────────────────────────┐        │
│  │ Class A 策略（波动）:                │        │
│  │                                     │        │
│  │ if (cur_soc > max_soc) {           │        │
│  │   禁用充电                          │        │
│  │   限流 100mA                        │        │
│  │   work_mode = DISABLE_CHG_MODE     │        │
│  │ }                                   │        │
│  │                                     │        │
│  │ if (cur_soc < min_soc) {           │        │
│  │   启用充电                          │        │
│  │   解除限流                          │        │
│  │   work_mode = ENABLE_CHG_MODE      │        │
│  │ }                                   │        │
│  └─────────────────────────────────────┘        │
│                                                 │
│  或                                              │
│                                                 │
│  ┌─────────────────────────────────────┐        │
│  │ Class B 策略（保持）:                │        │
│  │                                     │        │
│  │ if (cur_soc >= max_soc) {          │        │
│  │   禁用充电                          │        │
│  │   限流 100mA                        │        │
│  │   work_mode = DISABLE_CHG_MODE     │        │
│  │ }                                   │        │
│  │                                     │        │
│  │ if (cur_soc == max_soc &&          │        │
│  │     work_mode == DISABLE_CHG) {    │        │
│  │   禁用充电                          │        │
│  │   解除限流（平衡模式）               │        │
│  │   work_mode = BALANCE_MODE         │        │
│  │ }                                   │        │
│  │                                     │        │
│  │ if (cur_soc < min_soc) {           │        │
│  │   启用充电                          │        │
│  │   解除限流                          │        │
│  │   work_mode = ENABLE_CHG_MODE      │        │
│  │ }                                   │        │
│  └─────────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
    ↓
30 秒后重复检测（或 5 秒快速模式）
    ↓
充电器拔出 → 恢复正常模式
```

---

## 三、核心数据结构

### 3.1 设备管理结构
```c
struct soc_ctrl_dev {
    struct device *dev;              // Sysfs 设备节点
    struct notifier_block nb;        // 充电事件通知器
    struct delayed_work work;        // 延迟工作队列
    
    // 控制参数
    int work_mode;                   // 工作模式（状态机）
    int event;                       // 当前事件（START/STOP）
    int enable;                      // 是否启用 SOC 控制（0/1）
    int min_soc;                     // 最小电量（%，如 55）
    int max_soc;                     // 最大电量（%，如 75）
    int strategy;                    // 控制策略（Class A/B）
    int soc_ctrl_interval;           // 控制周期（ms，30s 或 5s）
};
```

### 3.2 工作模式枚举
```c
enum soc_ctrl_work_mode {
    WORK_IN_DEFAULT_MODE,        // 正常模式（未启用控制）
    WORK_IN_ENABLE_CHG_MODE,     // 充电使能模式（电量低于下限）
    WORK_IN_DISABLE_CHG_MODE,    // 充电禁用模式（电量高于上限）
    WORK_IN_BALANCE_MODE,        // 平衡模式（仅 Class B）
};
```

**模式说明**：
- **DEFAULT_MODE**：未启用 SOC 控制，正常充放电
- **ENABLE_CHG_MODE**：电量 < min_soc，启用充电
- **DISABLE_CHG_MODE**：电量 > max_soc，禁用充电并限流
- **BALANCE_MODE**：电量 == max_soc（Class B），禁充但不限流

### 3.3 控制策略枚举
```c
enum soc_ctrl_strategy_type {
    STRATEGY_TYPE_CLASS_A,       // 波动策略
    STRATEGY_TYPE_CLASS_B,       // 保持策略
};
```

**策略对比**：

| 特性 | Class A（波动） | Class B（保持） |
|------|----------------|----------------|
| 电量范围 | 55%-75% 之间波动 | 恰好维持在 75% |
| 充电控制 | 超 75% 禁充，低于 55% 启充 | 达到 75% 后保持 |
| 限流策略 | 禁充时限流 100mA | 禁充初期限流，后解除限流 |
| 工作模式 | 仅使用 ENABLE/DISABLE 模式 | 使用 ENABLE/DISABLE/BALANCE 三种模式 |
| 检测周期 | 固定 30s | 接近上限时 5s，否则 30s |
| 适用场景 | 一般保护场景 | 精确维持电量（展示机） |

### 3.4 操作用户枚举
```c
enum soc_ctrl_op_user {
    SOC_CTRL_OP_USER_DEFAULT,    // 默认用户
    SOC_CTRL_OP_USER_RC,         // RC 文件（开机脚本）
    SOC_CTRL_OP_USER_HIDL,       // HIDL 接口（Android HAL）
    SOC_CTRL_OP_USER_BMS_SOC,    // BMS SOC 守护进程
    SOC_CTRL_OP_USER_SHELL,      // Shell 命令
    SOC_CTRL_OP_USER_CUST,       // 定制化
    SOC_CTRL_OP_USER_DEMO,       // 展示机模式
    SOC_CTRL_OP_USER_BSOH,       // 电池健康度
    SOC_CTRL_OP_USER_BATT_CT,    // 电池 CT（容量测试）
};
```

---

## 四、核心算法与工作流程

### 4.1 Class A 策略（波动策略）

```c
static void soc_ctrl_startup_control_class_a(struct soc_ctrl_dev *l_dev)
{
    int cur_soc = power_supply_app_get_bat_capacity();
    
    hwlog_info("startup_a=%d cur_soc=%d, min_soc=%d, max_soc=%d\n",
        l_dev->work_mode, cur_soc, l_dev->min_soc, l_dev->max_soc);
    
    // 1. 电量超过上限（如 > 75%）
    if ((cur_soc > l_dev->max_soc) &&
        (l_dev->work_mode != WORK_IN_DISABLE_CHG_MODE)) {
        
        // 禁用充电
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ALL,
            POWER_IF_SYSFS_ENABLE_CHARGER, SOC_CTRL_CHG_DISABLE);
        
        // 限制输入电流为 100mA（仅供系统维持运行）
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, SOC_CTRL_IIN_LIMIT);
        
        l_dev->work_mode = WORK_IN_DISABLE_CHG_MODE;
    }
    
    // 2. 电量低于下限（如 < 55%）
    if ((cur_soc < l_dev->min_soc) &&
        (l_dev->work_mode != WORK_IN_ENABLE_CHG_MODE)) {
        
        // 启用充电
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ALL,
            POWER_IF_SYSFS_ENABLE_CHARGER, SOC_CTRL_CHG_ENABLE);
        
        // 解除输入电流限制
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, SOC_CTRL_IIN_UNLIMIT);
        
        l_dev->work_mode = WORK_IN_ENABLE_CHG_MODE;
    }
}
```

**工作时序**（以 55%-75% 为例）：
```
T0: 电量 50%, 启用充电
    ↓
T1: 电量上升至 55%-75% 之间, 继续充电
    ↓
T2: 电量达到 76%, 禁用充电, 限流 100mA
    ↓
T3: 电量缓慢下降（系统耗电）
    ↓
T4: 电量降至 75%-55% 之间, 保持禁充
    ↓
T5: 电量降至 54%, 启用充电, 解除限流
    ↓
循环往复...
```

### 4.2 Class B 策略（保持策略）

```c
static void soc_ctrl_startup_control_class_b(struct soc_ctrl_dev *l_dev)
{
    int cur_soc = power_supply_app_get_bat_capacity();
    
    hwlog_info("startup_b=%d cur_soc=%d, min_soc=%d, max_soc=%d\n",
        l_dev->work_mode, cur_soc, l_dev->min_soc, l_dev->max_soc);
    
    // 1. 动态调整检测周期
    if (l_dev->max_soc - cur_soc <= SOC_CTRL_SOC_D_VALUE)  // 差值 ≤ 2%
        l_dev->soc_ctrl_interval = SOC_CTRL_LOOP_TIME_FAST;  // 5s
    else
        l_dev->soc_ctrl_interval = SOC_CTRL_LOOP_TIME;       // 30s
    
    // 2. 电量达到或超过上限（如 >= 75%）
    if ((cur_soc >= l_dev->max_soc) &&
        (l_dev->work_mode != WORK_IN_DISABLE_CHG_MODE)) {
        
        // 禁用充电
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ALL,
            POWER_IF_SYSFS_ENABLE_CHARGER, SOC_CTRL_CHG_DISABLE);
        
        // 限制输入电流为 100mA
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, SOC_CTRL_IIN_LIMIT);
        
        l_dev->work_mode = WORK_IN_DISABLE_CHG_MODE;
    }
    
    // 3. 电量恰好等于上限（如 == 75%）且已禁充
    if ((cur_soc == l_dev->max_soc) &&
        (l_dev->work_mode == WORK_IN_DISABLE_CHG_MODE)) {
        
        // 保持禁用充电
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ALL,
            POWER_IF_SYSFS_ENABLE_CHARGER, SOC_CTRL_CHG_DISABLE);
        
        // 解除输入电流限制（平衡模式）
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, SOC_CTRL_IIN_UNLIMIT);
        
        l_dev->work_mode = WORK_IN_BALANCE_MODE;
    }
    
    // 4. 电量低于下限（如 < 55%）
    if ((cur_soc < l_dev->min_soc) &&
        (l_dev->work_mode != WORK_IN_ENABLE_CHG_MODE)) {
        
        // 启用充电，解除限流
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ALL,
            POWER_IF_SYSFS_ENABLE_CHARGER, SOC_CTRL_CHG_ENABLE);
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, SOC_CTRL_IIN_UNLIMIT);
        
        l_dev->work_mode = WORK_IN_ENABLE_CHG_MODE;
    }
}
```

**工作时序**（以 55%-75% 为例）：
```
T0: 电量 50%, 启用充电, 周期 30s
    ↓
T1: 电量 73%, 接近上限, 周期切换至 5s（快速监控）
    ↓
T2: 电量 75%, 禁用充电, 限流 100mA
    ↓
T3: 电量 75%（稳定）, 保持禁充, 解除限流（平衡模式）
    ↓
T4: 系统功耗 < 100mA, 电量维持在 75%
    ↓
T5: 若电量降至 74%, 周期 5s 快速检测
    ↓
T6: 电量继续降至 54%, 启用充电, 周期恢复 30s
```

**Class B 优势**：
- 精确维持在目标电量（如 75%）
- 通过解除限流实现功耗平衡
- 接近目标时快速检测（5s）避免超调

### 4.3 投票机制（Power Vote）

```c
// 上限投票回调
static int soc_ctrl_h_vote_callback(struct power_vote_object *obj,
    void *data, int result, const char *client_str)
{
    struct soc_ctrl_dev *l_dev = (struct soc_ctrl_dev *)data;
    
    hwlog_info("h_vote result=%d\n", result);
    
    // 忽略相同的控制事件
    if ((l_dev->enable && (l_dev->max_soc == result)) ||
        (!l_dev->enable && (result < 0))) {
        return 0;
    }
    
    if (result < 0) {
        l_dev->enable = 0;  // 禁用控制
    } else {
        if (result < l_dev->min_soc) {
            hwlog_err("err:max_soc < min_soc\n");
            return -EINVAL;
        }
        l_dev->max_soc = result;
        l_dev->enable = 1;  // 启用控制
    }
    
    // 处理 SOC 控制
    soc_ctrl_event_control(l_dev->event);
    return 0;
}

// 下限投票回调
static int soc_ctrl_l_vote_callback(struct power_vote_object *obj,
    void *data, int result, const char *client_str)
{
    struct soc_ctrl_dev *l_dev = (struct soc_ctrl_dev *)data;
    
    hwlog_info("l_vote result=%d\n", result);
    
    // 仅更新 min_soc，与 max_soc 协同工作
    if (result >= 0)
        l_dev->min_soc = result;
    
    return 0;
}
```

**投票示例**：
```bash
# 用户 demo 投票: 55%-75%
echo "demo 1 55 75" > /sys/class/hw_power/soc_control/control
# 内部执行:
#   power_vote_set(soc_ctrl_l, "demo", 1, 55)  → min_soc = 55
#   power_vote_set(soc_ctrl_h, "demo", 1, 75)  → max_soc = 75

# 用户 shell 投票: 60%-80%
echo "shell 1 60 80" > /sys/class/hw_power/soc_control/control
# 内部执行:
#   power_vote_set(soc_ctrl_l, "shell", 1, 60) → min_soc = min(55, 60) = 55
#   power_vote_set(soc_ctrl_h, "shell", 1, 80) → max_soc = min(75, 80) = 75
# 最终结果: 仍为 55%-75%（取最严格限制）
```

**投票策略**：
- 采用 `POWER_VOTE_SET_MIN` 模式
- 多个用户投票时取**最小值**
- 确保最严格的限制生效

---

## 五、Sysfs 接口

### 5.1 节点路径
```bash
/sys/class/hw_power/soc_control/
├── control    # 读写：控制使能和电量范围
└── strategy   # 读写：选择控制策略
```

### 5.2 接口说明

#### control（读写）

**读取**：
```bash
cat /sys/class/hw_power/soc_control/control
# 输出格式：
# enable=1, min_soc=55, max_soc=75
```

**写入格式**：
```bash
echo "<user> <enable> <min_soc> <max_soc>" > control

# 参数说明：
# user: 操作用户（default/rc/hidl/shell/demo/bsoh/batt_ct 等）
# enable: 0=禁用, 1=启用
# min_soc: 最小电量（0-100, 必须 max_soc - min_soc >= 5）
# max_soc: 最大电量（0-100）
```

**使用示例**：
```bash
# Shell 用户启用 SOC 控制，范围 55%-75%
echo "shell 1 55 75" > /sys/class/hw_power/soc_control/control

# Demo 用户启用，范围 60%-80%
echo "demo 1 60 80" > /sys/class/hw_power/soc_control/control

# Shell 用户禁用 SOC 控制
echo "shell 0 0 0" > /sys/class/hw_power/soc_control/control
```

**参数校验**：
```c
// 1. enable 必须为 0 或 1
if ((enable < 0) || (enable > 1))
    return -EINVAL;

// 2. soc 必须在 0-100 之间，且上下限差值 >= 5
if ((min_soc < 0 || min_soc > 100) ||
    (max_soc < 0 || max_soc > 100) ||
    (min_soc + 5 > max_soc))
    return -EINVAL;
```

#### strategy（读写）

**读取**：
```bash
cat /sys/class/hw_power/soc_control/strategy
# 输出：0 (Class A) 或 1 (Class B)
```

**写入格式**：
```bash
echo "<user> <strategy>" > strategy

# 参数说明：
# user: 操作用户
# strategy: 0=Class A（波动）, 1=Class B（保持）
```

**使用示例**：
```bash
# 设置为 Class A 策略
echo "shell 0" > /sys/class/hw_power/soc_control/strategy

# 设置为 Class B 策略
echo "shell 1" > /sys/class/hw_power/soc_control/strategy
```

---

## 六、典型应用场景

### 6.1 场景1：展示机模式（Demo 模式）

```
应用背景：
零售店展示机长期插电展示，需防止电池过充

配置方案：
策略: Class B（保持在固定电量）
范围: 60%-75%

操作步骤：
1. 设置策略为 Class B
   echo "demo 1" > /sys/class/hw_power/soc_control/strategy

2. 设置电量范围
   echo "demo 1 60 75" > /sys/class/hw_power/soc_control/control

3. 插入充电器，设备自动控制电量维持在 75%

工作流程：
T0: 初始电量 50%, 启用充电
    ↓
T1: 电量充至 75%, 禁用充电并解除限流
    ↓
T2: 系统功耗由充电器供应（通过模式），电量稳定在 75%
    ↓
T3: 若电量降至 74%, 5 秒快速检测
    ↓
T4: 长期维持在 75% 左右

效果：
- 电池长期处于健康电量区间
- 延长电池寿命 40%-60%
- 展示机可使用 2-3 年无需换电池
```

### 6.2 场景2：工作站模式（桌面使用）

```
应用背景：
用户将手机当作工作站，长期连接显示器、键鼠使用

配置方案：
策略: Class A（波动）
范围: 50%-70%

操作步骤：
1. 用户在系统设置中启用"电池保护模式"
2. Framework 通过 HIDL 接口设置：
   echo "hidl 1" > /sys/class/hw_power/soc_control/strategy
   echo "hidl 1 50 70" > /sys/class/hw_power/soc_control/control

工作流程：
T0: 电量 45%, 启用充电
    ↓
T1: 电量充至 71%, 禁用充电, 限流 100mA
    ↓
T2: 电量缓慢下降至 55%-70% 区间
    ↓
T3: 电量降至 49%, 启用充电, 解除限流
    ↓
T4: 循环往复, 电量在 50%-70% 波动

效果：
- 避免长期满电加速老化
- 电池循环寿命延长 30%-50%
- 适合长期插电办公场景
```

### 6.3 场景3：电池容量测试（Battery CT）

```
应用背景：
工厂生产线或售后维修需要测试电池容量

配置方案：
策略: Class A
范围: 20%-80%（测试区间）

操作步骤：
1. 测试设备通过 ADB 设置：
   adb shell
   echo "batt_ct 1 20 80" > /sys/class/hw_power/soc_control/control

2. 插入充电器，自动充放电循环

测试流程：
T0: 电量 15%, 启用充电
    ↓
T1: 充至 81%, 禁用充电
    ↓
T2: 放电至 19%, 启用充电
    ↓
T3: 记录充放电曲线，计算容量
    ↓
T4: 测试完成，禁用控制

效果：
- 自动化容量测试
- 避免过充过放损伤电池
- 提高测试效率
```

### 6.4 场景4：电池健康度管理（BSOH）

```
应用背景：
检测到电池健康度下降，主动限制充电范围

配置方案：
策略: Class B
范围: 40%-60%（老化电池保护）

触发条件：
if (battery_soh < 80%) {
    echo "bsoh 1" > /sys/class/hw_power/soc_control/strategy
    echo "bsoh 1 40 60" > /sys/class/hw_power/soc_control/control
}

工作流程：
1. 电池健康度检测模块检测到 SOH < 80%
2. 自动启用 SOC 控制，范围缩小至 40%-60%
3. 电量维持在 60% 左右
4. 延缓电池进一步老化

效果：
- 延长老化电池使用寿命
- 减少意外关机风险
- 改善用户体验
```

---

## 七、调试方法

### 7.1 日志关键点
```bash
# 1. 投票结果日志
[soc_control] h_vote result=75
[soc_control] l_vote result=55

# 2. Class A 策略日志
[soc_control] startup_a=1 cur_soc=76, min_soc=55, max_soc=75
[soc_control] startup_a=2 cur_soc=54, min_soc=55, max_soc=75

# 3. Class B 策略日志
[soc_control] startup_b=1 cur_soc=75, min_soc=55, max_soc=75
[soc_control] startup_b=3 cur_soc=75, min_soc=55, max_soc=75

# 4. 恢复正常模式日志
[soc_control] recovery=1 cur_soc=65, min_soc=55, max_soc=75

# 5. 事件控制日志
[soc_control] enable: start soc control
[soc_control] enable: stop soc control
[soc_control] disable: event=1
```

### 7.2 Sysfs 调试
```bash
# 查看当前状态
cat /sys/class/hw_power/soc_control/control
# 输出: enable=1, min_soc=55, max_soc=75

cat /sys/class/hw_power/soc_control/strategy
# 输出: 1 (Class B)

# 查看充电使能状态
cat /sys/class/power_supply/battery/charging_enabled
# 输出: 0 (禁用) 或 1 (启用)

# 查看输入电流限制
cat /sys/class/power_supply/usb/current_max
# 输出: 100000 (100mA) 或更大值
```

### 7.3 实时监控脚本
```bash
#!/bin/bash
# soc_control_monitor.sh

while true; do
    SOC=$(cat /sys/class/power_supply/battery/capacity)
    CHG_EN=$(cat /sys/class/power_supply/battery/charging_enabled)
    IIN=$(cat /sys/class/power_supply/usb/current_max)
    
    echo "$(date '+%H:%M:%S') SOC=$SOC% CHG_EN=$CHG_EN IIN=${IIN}uA"
    sleep 5
done

# 运行示例:
# chmod +x soc_control_monitor.sh
# ./soc_control_monitor.sh

# 输出示例:
# 10:00:00 SOC=73% CHG_EN=1 IIN=2000000uA
# 10:00:05 SOC=74% CHG_EN=1 IIN=2000000uA
# 10:00:10 SOC=75% CHG_EN=1 IIN=2000000uA
# 10:00:15 SOC=76% CHG_EN=0 IIN=100000uA   ← 禁充并限流
# 10:00:20 SOC=76% CHG_EN=0 IIN=100000uA
# 10:00:25 SOC=75% CHG_EN=0 IIN=2000000uA   ← 解除限流（平衡模式）
```

### 7.4 常见问题排查

#### 问题1：SOC 控制未生效
**现象**：设置后电量仍充至 100%

**排查步骤**：
1. 检查是否启用：
   ```bash
   cat /sys/class/hw_power/soc_control/control
   # 应显示 enable=1
   ```
2. 检查充电事件：
   ```bash
   dmesg | grep "start soc control"
   # 应在充电器插入后看到日志
   ```
3. 检查工作队列：
   ```bash
   dmesg | grep "startup"
   # 应每 30s（或 5s）看到一次日志
   ```

#### 问题2：电量波动过大
**现象**：Class A 模式下电量在 50%-80% 大幅波动

**原因分析**：
- 上下限设置过宽（max_soc - min_soc > 20%）

**解决方案**：
```bash
# 缩小范围至 10%-15%
echo "shell 1 60 70" > /sys/class/hw_power/soc_control/control
```

#### 问题3：Class B 无法维持固定电量
**现象**：电量在 74%-76% 波动

**原因分析**：
- 系统功耗波动导致
- 电量计精度限制（±1%）

**优化方案**：
- 正常现象，±1% 波动可接受
- 若波动 > 2%，检查系统功耗

#### 问题4：限流 100mA 过低导致关机
**现象**：禁充后设备因功耗过高关机

**原因分析**：
- 系统功耗 > 100mA（如屏幕亮度高、后台应用多）

**解决方案**：
```c
// 修改限流值（需重新编译）
#define SOC_CTRL_IIN_LIMIT   500  // 改为 500mA

// 或使用 Class B 策略（平衡模式不限流）
echo "shell 1" > /sys/class/hw_power/soc_control/strategy
```

---

## 八、总结

### 8.1 技术特点
1. **双策略支持**：Class A 波动策略和 Class B 保持策略满足不同场景
2. **投票机制**：多用户协同控制，取最严格限制
3. **动态调整**：Class B 接近目标时快速检测（5s）
4. **平衡模式**：Class B 特有，解除限流维持固定电量

### 8.2 设计亮点
- **状态机管理**：清晰的工作模式切换逻辑
- **智能限流**：禁充时限流 100mA 供系统运行，避免断电
- **精确控制**：Class B 可精确维持在目标电量（±1%）
- **事件驱动**：充电插拔自动启停控制，无需手动干预

### 8.3 应用价值
- **延长电池寿命**：避免长期高电量，延长 30%-60% 循环寿命
- **展示机必备**：零售店展示机可使用 2-3 年无需换电池
- **工作站模式**：长期插电办公不损伤电池
- **电池保护**：老化电池通过限制范围延缓衰退

### 8.4 局限性
- **仅限充电状态**：拔出充电器后无法控制
- **依赖电量计精度**：电量计误差影响控制精度
- **无温度保护**：未考虑温度对电池的影响
- **限流可能不足**：100mA 对高功耗应用可能不够

### 8.5 改进方向
1. **温度联动**：
   - 高温时降低 max_soc（如 40°C 时降至 70%）
   - 低温时提高 min_soc（如 0°C 时提高至 60%）

2. **智能限流**：
   - 根据系统功耗动态调整限流值
   - 避免限流过低导致关机

3. **电池健康联动**：
   - SOH < 80% 时自动启用并缩小范围
   - 循环次数 > 500 次时推荐用户启用

4. **用户提醒**：
   - Framework 层提示用户当前处于电池保护模式
   - 显示预计延长的电池寿命
