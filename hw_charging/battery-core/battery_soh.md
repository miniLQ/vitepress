---
outline: deep
---

# 华为电池核心之battery_soh模块

## 一、模块概述

battery_soh.c 是华为电源管理框架中的**电池健康度（SOH）管理驱动**，核心功能：
- **SOH 子系统管理框架**（插件式架构）
- **事件通知机制**（uevent/event）
- **DSM 异常上报管理**
- **电池健康度数据统一接口**

## 二、核心数据结构

### 1. **设备结构体**

```c
struct bsoh_device {
    struct device *dev;
    struct delayed_work bsoh_dmd_wrok;  // DMD 上报延迟工作队列
    struct list_head dmd_list_head;     // DMD 条目链表头
    struct mutex dmd_list_lock;         // DMD 链表互斥锁
    unsigned int sub_sys_enable;        // 子系统使能位图
};
```

### 2. **子系统接口**

```c
struct bsoh_sub_sys {
    int (*sys_init)(struct bsoh_device *di);                    // 子系统初始化
    void (*sys_exit)(struct bsoh_device *di);                   // 子系统退出
    void (*event_notify)(struct bsoh_device *di, unsigned int event);  // 事件通知
    void (*dmd_prepare)(char *buff, unsigned int size);         // DMD 准备函数
    const char *type_name;                                      // 子系统类型名
    const char *notify_node;                                    // 通知节点名
};
```

### 3. **DMD 条目**
```c
struct bsoh_dmd_entry {
    struct list_head node;              // 链表节点
    unsigned int dmd_no;                // DMD 错误号
    unsigned int retry_times;           // 重试次数
    void (*prepare)(char *buff, unsigned int size);  // 准备函数
};
```

### 4. **子系统类型枚举**

```c
enum bsoh_sub_sys_type {
    BSOH_SUB_SYS_BEGIN = 0,
    BSOH_SUB_SYS_BASP = BSOH_SUB_SYS_BEGIN,  // Battery Aging State Predict
    BSOH_SUB_SYS_ISCD,                       // Internal Short Circuit Detect
    BSOH_SUB_SYS_CFSD,                       // Cell Failure State Detect
    BSOH_SUB_SYS_ICM,                        // Impedance Calculation Module
    BSOH_SUB_SYS_END,
};
```

### 5. **事件类型枚举**

```c
enum bsoh_uevent_type {
    BSOH_EVT_BEGIN = 0,
    BSOH_EVT_OCV_UPDATE = BSOH_EVT_BEGIN,    // OCV 更新
    BSOH_EVT_SOH_DCR_UPDATE,                 // DCR (直流内阻) 更新
    BSOH_EVT_SOH_ACR_UPDATE,                 // ACR (交流内阻) 更新
    BSOH_EVT_EIS_FREQ_UPDATE,                // EIS 频率更新
    BSOH_EVT_BATT_INFO_UPDATE,               // 电池信息更新
    BSOH_EVT_END,
};
```

---

## 三、关键功能模块

### 1. **子系统注册机制**
#### 注册流程：
```c
void bsoh_register_sub_sys(enum bsoh_sub_sys_type type,
    const struct bsoh_sub_sys *sub_sys)
{
    // 1. 参数校验
    if (!sub_sys)
        return;
    if ((type < BSOH_SUB_SYS_BEGIN) || (type >= BSOH_SUB_SYS_END))
        return;
    
    // 2. 注册到全局数组
    g_bsoh_sub_sys[type] = sub_sys;
}
```

#### 注销流程：
```c
void bsoh_unregister_sub_sys(enum bsoh_sub_sys_type type)
{
    // 1. 调用子系统退出函数
    if (g_bsoh_sub_sys[type] && g_bsoh_sub_sys[type]->sys_exit)
        g_bsoh_sub_sys[type]->sys_exit(di);
    
    // 2. 清空注册指针
    g_bsoh_sub_sys[type] = NULL;
}
```

#### 全局子系统表：
```c
static const struct bsoh_sub_sys *g_bsoh_sub_sys[BSOH_SUB_SYS_END];
```

#### 插件式架构示例：
```c
// BASP 子系统注册
static const struct bsoh_sub_sys basp_sub_sys = {
    .sys_init = basp_init,
    .sys_exit = basp_exit,
    .event_notify = basp_event_notify,
    .dmd_prepare = basp_dmd_prepare,
    .type_name = "basp",
    .notify_node = "basp_data",
};

// 在 BASP 模块初始化时注册
bsoh_register_sub_sys(BSOH_SUB_SYS_BASP, &basp_sub_sys);
```

---

### 2. **uevent 事件发送**
#### 核心流程：
```c
void bsoh_uevent_rcv(unsigned int event, const char *data)
{
    // 1. 事件类型校验
    if (event >= BSOH_EVT_END) {
        hwlog_err("invalid bsoh event\n");
        return;
    }
    
    // 2. 分配事件字符串缓冲区
    bsoh_event = kzalloc(BSOH_EVENT_NOTIFY_SIZE, GFP_KERNEL);
    
    // 3. 格式化事件字符串
    snprintf(bsoh_event, BSOH_EVENT_NOTIFY_SIZE, "BSOH_EVT=%s",
        g_bsoh_event_table[event]);
    
    // 4. 追加额外数据（可选）
    if (data) {
        snprintf(bsoh_event + len, BSOH_EVENT_NOTIFY_SIZE - len, 
            "@%s", data);
    }
    
    // 5. 发送 uevent 到用户空间
    n_data.event = bsoh_event;
    n_data.event_len = len + RSV_END_SPACE;
    power_event_report_uevent(&n_data);
    
    // 6. 释放缓冲区
    kfree(bsoh_event);
}
```

#### 事件字符串表
```c
static const char * const g_bsoh_event_table[BSOH_EVT_END] = {
    [BSOH_EVT_OCV_UPDATE]       = "EVT_OCV_UPDATE",
    [BSOH_EVT_SOH_DCR_UPDATE]   = "EVT_SOH_DCR_UPDATE",
    [BSOH_EVT_SOH_ACR_UPDATE]   = "EVT_SOH_ACR_UPDATE",
    [BSOH_EVT_EIS_FREQ_UPDATE]  = "EVT_EIS_FREQ_UPDATE",
    [BSOH_EVT_BATT_INFO_UPDATE] = "EVT_BATT_INFO_UPDATE",
};
```

#### uevent 格式示例：
```bash
# 示例 1：单纯事件
BSOH_EVT=EVT_OCV_UPDATE

# 示例 2：带额外数据
BSOH_EVT=EVT_SOH_DCR_UPDATE@dcr=150,soh=85

# 示例 3：电池信息更新
BSOH_EVT=EVT_BATT_INFO_UPDATE@cycles=300,capacity=4000
```

#### 用户空间接收：
```bash
# Android Init.rc 监听 uevent
on property:BSOH_EVT=EVT_SOH_DCR_UPDATE
    # 触发电池健康度更新
    start battery_soh_service
```

---

### 3. **内部事件分发**

```c
void bsoh_event_rcv(unsigned int event)
{
    // 遍历所有子系统
    for (i = 0; i < BSOH_SUB_SYS_END; i++) {
        if (!g_bsoh_sub_sys[i])
            continue;
        
        // 检查子系统是否使能
        enable = g_bsoh_device->sub_sys_enable & BIT(i);
        
        // 调用子系统事件处理函数
        if (enable && g_bsoh_sub_sys[i]->event_notify)
            g_bsoh_sub_sys[i]->event_notify(g_bsoh_device, event);
    }
}
```

#### 调用示例：
```c
// 充电状态变化时通知所有子系统
void charging_state_changed(void)
{
    bsoh_event_rcv(POWER_NE_CHARGING_START);
}
```

---

### 4. **DSM 异常上报管理**

#### DSM 上报流程：
```c
bsoh_dmd_append(type_name, dmd_no)
    ↓
1. 查找子系统
   sys = bsoh_get_sub_sys(type_name);
    ↓
2. 创建 DMD 条目
   temp = kzalloc(sizeof(*temp), GFP_KERNEL);
   temp->dmd_no = dmd_no;
   temp->prepare = sys->dmd_prepare;
    ↓
3. 添加到链表
   mutex_lock(&di->dmd_list_lock);
   list_add_tail(&temp->node, &di->dmd_list_head);
   mutex_unlock(&di->dmd_list_lock);
    ↓
4. 调度延迟工作队列（3秒后）
   schedule_delayed_work(&di->bsoh_dmd_wrok, 3 * HZ);
    ↓
5. 工作队列处理
   bsoh_dmd_work()
    ↓
6. 遍历链表上报
   list_for_each_entry_safe(pos, tmp, &di->dmd_list_head, node)
    ↓
7. 调用 prepare 准备数据
   pos->prepare(buff, BSOH_MAX_DMD_BUF_SIZE);
    ↓
8. 上报 DSM
   power_dsm_report_dmd(POWER_DSM_BATTERY, pos->dmd_no, buff);
    ↓
9. 失败重试（最多 3 次）
   if (失败 && pos->retry_times < 3)
       重新调度工作队列
    ↓
10. 成功或超过重试次数
    list_del_init(&pos->node);
    kfree(pos);
```

#### 核心函数：

##### DMD 上报函数
```c
static int bsoh_dmd_report(struct bsoh_dmd_entry *entry)
{
    char *buff = NULL;
    
    // 1. 分配缓冲区
    buff = kzalloc(BSOH_MAX_DMD_BUF_SIZE, GFP_KERNEL);
    
    // 2. 调用子系统 prepare 函数填充数据
    entry->prepare(buff, BSOH_MAX_DMD_BUF_SIZE);
    buff[BSOH_MAX_DMD_BUF_SIZE - 1] = '\0';
    
    // 3. 上报 DSM
    if (power_dsm_report_dmd(POWER_DSM_BATTERY, entry->dmd_no, buff)) {
        kfree(buff);
        return -EPERM;  // 上报失败
    }
    
    kfree(buff);
    return 0;  // 上报成功
}
```

##### 工作队列处理
```c
static void bsoh_dmd_work(struct work_struct *work)
{
    mutex_lock(&di->dmd_list_lock);
    
    // 遍历 DMD 链表
    list_for_each_entry_safe(pos, tmp, &di->dmd_list_head, node) {
        pos->retry_times++;
        
        // 上报失败且未超过重试次数
        if (bsoh_dmd_report(pos) && 
            (pos->retry_times < BSOH_MAX_DMD_REPORT_TIMES)) {
            mutex_unlock(&di->dmd_list_lock);
            schedule_delayed_work(&di->bsoh_dmd_wrok, 3 * HZ);  // 3秒后重试
            return;
        }
        
        // 上报成功或超过重试次数，删除条目
        list_del_init(&pos->node);
        kfree(pos);
    }
    
    mutex_unlock(&di->dmd_list_lock);
}
```

#### 使用示例：
```c
// BASP 子系统检测到电池异常老化
void basp_detect_abnormal_aging(void)
{
    // 追加 DMD 上报任务
    bsoh_dmd_append("basp", POWER_DSM_BATTERY_ABNORMAL_AGING);
}

// BASP 准备 DMD 数据
void basp_dmd_prepare(char *buff, unsigned int size)
{
    snprintf(buff, size,
        "[BASP]cycles=%d,soh=%d,fcc=%d,voltage=%d\n",
        cycle_count, soh_value, fcc, voltage);
}
```

---

### 5. **Sysfs 接口实现**

#### 节点列表：

| 节点名 | 权限 | 类型 | 功能 |
|--------|------|------|------|
| `bsoh_battery_removed` | R (0444) | RO | 检查电池是否更换 |
| `bsoh_subsys` | R (0444) | RO | 查看已使能的子系统列表 |
| `bsoh_dmd_report` | W (0220) | WO | 触发 DMD 上报 |
| `bsoh_sysfs_notify` | W (0220) | WO | Debug 节点（触发 sysfs 通知）|

#### 节点实现：

##### 1. 电池更换检测
```c
static ssize_t bsoh_battery_removed_show(struct device *dev,
    struct device_attribute *attr, char *buff)
{
    int flag = power_platform_is_battery_changed();
    
    memmove(buff, &flag, sizeof(flag));
    return sizeof(flag);
}
```

##### 2. 子系统列表查询
```c
static ssize_t bsoh_subsys_show(struct device *dev,
    struct device_attribute *attr, char *buff)
{
    // 遍历所有子系统
    for (i = 0; i < BSOH_SUB_SYS_END; i++) {
        if (!g_bsoh_sub_sys[i])
            continue;
        
        // 检查是否使能
        enable = g_bsoh_device->sub_sys_enable & BIT(i);
        if (!enable || !g_bsoh_sub_sys[i]->type_name)
            continue;
        
        // 格式化输出（逗号分隔）
        if (len > 0)
            len += snprintf(buff + len, PAGE_SIZE - len - 1, 
                ",%s", g_bsoh_sub_sys[i]->type_name);
        else
            len += snprintf(buff + len, PAGE_SIZE - len - 1, 
                "%s", g_bsoh_sub_sys[i]->type_name);
    }
    
    return len;
}
```

##### 输出示例：
```bash
# 查看使能的子系统
cat /sys/devices/platform/battery-soh/bsoh_subsys
# 输出: basp,iscd,icm
```

##### 3. DMD 手动上报
```c
static ssize_t bsoh_dmd_report_store(struct device *dev,
    struct device_attribute *attr, const char *buf, size_t count)
{
    unsigned int dmd_no;
    char type_name[BSOH_MAX_RD_BUF_SIZE] = { 0 };
    
    // 解析输入："type_name dmd_no"
    if (sscanf(buf, "%s %u", type_name, &dmd_no) != 2) {
        hwlog_err("unable to parse input:%s\n", buf);
        return -EINVAL;
    }
    
    // 追加 DMD 上报
    bsoh_dmd_append(type_name, dmd_no);
    
    return count;
}
```

##### 使用示例：
```bash
# 手动触发 BASP 子系统 DMD 上报
echo "basp 920003001" > /sys/devices/platform/battery-soh/bsoh_dmd_report

# 查看日志
dmesg | grep battery_soh
# to report basp dmd and no is 920003001
```

##### 4. Sysfs 通知触发
```c
#ifdef CONFIG_HUAWEI_POWER_DEBUG
static ssize_t bsoh_sysfs_notify_store(struct device *dev,
    struct device_attribute *attr, const char *buf, size_t count)
{
    const struct bsoh_sub_sys *sys = NULL;
    
    // 根据 type_name 查找子系统
    sys = bsoh_get_sub_sys(buf);
    if (!sys || !sys->notify_node) {
        hwlog_err("invalid type name %s\n", buf);
        return -EPERM;
    }
    
    // 触发 sysfs 通知
    power_event_notify_sysfs(&dev->kobj, sys->type_name, sys->notify_node);
    
    return count;
}
#endif
```

---

### 6. **DTS 配置解析**

```c
static int bsoh_dts_parse(struct device_node *np, struct bsoh_device *di)
{
    // 遍历所有子系统
    for (i = 0; i < BSOH_SUB_SYS_END; i++) {
        if (!g_bsoh_sub_sys[i] || !g_bsoh_sub_sys[i]->type_name)
            continue;
        
        // 读取子系统使能配置
        subsys_enable = 0;
        (void)power_dts_read_u32(power_dts_tag(HWLOG_TAG), np,
            g_bsoh_sub_sys[i]->type_name, &subsys_enable, 0);
        
        // 设置使能位
        di->sub_sys_enable |= (!!subsys_enable) << i;
    }
    
    return 0;
}
```

#### DTS 配置示例：
```
battery_soh {
    compatible = "huawei,battery-soh";
    
    /* 子系统使能配置 */
    basp = <1>;  // Battery Aging State Predict 使能
    iscd = <1>;  // Internal Short Circuit Detect 使能
    cfsd = <0>;  // Cell Failure State Detect 禁用
    icm  = <1>;  // Impedance Calculation Module 使能
};
```

#### 使能位图示例：
```
di->sub_sys_enable 位图:
  Bit 0: BASP (1 = 使能)
  Bit 1: ISCD (1 = 使能)
  Bit 2: CFSD (0 = 禁用)
  Bit 3: ICM  (1 = 使能)

结果: 0b1011 = 0x0B
```

---

### 7. **子系统初始化/退出**

#### 初始化流程：
```c
static void bsoh_sub_sys_init(struct bsoh_device *di)
{
    for (i = 0; i < BSOH_SUB_SYS_END; i++) {
        if (!g_bsoh_sub_sys[i])
            continue;
        
        // 检查是否使能
        enable = di->sub_sys_enable & BIT(i);
        
        // 调用子系统初始化函数
        if (enable && g_bsoh_sub_sys[i]->sys_init &&
            g_bsoh_sub_sys[i]->sys_init(di))
            hwlog_err("create sub system %d failed\n", i);
    }
}
```

#### 退出流程：
```c
static void bsoh_sub_sys_exit(struct bsoh_device *di)
{
    for (i = 0; i < BSOH_SUB_SYS_END; i++) {
        if (!g_bsoh_sub_sys[i])
            continue;
        
        enable = g_bsoh_device->sub_sys_enable & BIT(i);
        
        // 调用子系统退出函数
        if (enable && g_bsoh_sub_sys[i]->sys_exit)
            g_bsoh_sub_sys[i]->sys_exit(di);
    }
}
```

---

## 四、初始化流程

```
bsoh_probe()
├── 1. 分配设备结构体
│   └── devm_kzalloc(sizeof(struct bsoh_device))
├── 2. 解析 DTS 配置
│   └── bsoh_dts_parse()
│       └── 读取各子系统使能位
├── 3. 初始化 DMD 工作队列
│   └── INIT_DELAYED_WORK(&di->bsoh_dmd_wrok, bsoh_dmd_work)
├── 4. 初始化 DMD 链表
│   ├── INIT_LIST_HEAD(&di->dmd_list_head)
│   └── mutex_init(&di->dmd_list_lock)
├── 5. 创建 Sysfs 节点
│   └── bsoh_sysfs_create_files(di)
│       ├── bsoh_battery_removed
│       ├── bsoh_subsys
│       ├── bsoh_dmd_report
│       └── bsoh_sysfs_notify (DEBUG)
├── 6. 初始化所有使能的子系统
│   └── bsoh_sub_sys_init(di)
│       └── 调用各子系统 sys_init()
└── 7. 设置全局指针
    └── g_bsoh_device = di
```

---

## 五、模块卸载流程

```c
bsoh_remove()
├── 1. 退出所有子系统
│   └── bsoh_sub_sys_exit()
├── 2. 删除 Sysfs 节点
│   └── bsoh_sysfs_remove_files()
├── 3. 释放 DMD 资源
│   └── bsoh_free_dmd_resource()
│       ├── 遍历 DMD 链表
│       ├── 删除所有条目
│       └── 销毁互斥锁
└── 4. 清空全局指针
    └── g_bsoh_device = NULL
```

---

## 六、子系统架构设计

### 1. **插件式设计优势**

```
核心框架 (battery_soh.c)
    ├── 提供统一接口
    ├── 管理事件分发
    ├── 处理 DMD 上报
    └── 创建 Sysfs 节点
        ↓
子系统插件 (独立模块)
    ├── BASP (电池老化预测)
    ├── ISCD (内短路检测)
    ├── CFSD (电芯失效检测)
    └── ICM  (阻抗计算模块)
```

### 2. **子系统注册示例**

```c
// 示例：BASP 子系统实现
static int basp_init(struct bsoh_device *di)
{
    // BASP 初始化逻辑
    hwlog_info("BASP initialized\n");
    return 0;
}

static void basp_exit(struct bsoh_device *di)
{
    // BASP 清理逻辑
    hwlog_info("BASP exited\n");
}

static void basp_event_notify(struct bsoh_device *di, unsigned int event)
{
    // 处理事件
    switch (event) {
    case POWER_NE_CHARGING_START:
        // 充电开始，更新老化算法
        break;
    }
}

static void basp_dmd_prepare(char *buff, unsigned int size)
{
    // 准备 DMD 数据
    snprintf(buff, size, "[BASP]soh=%d,cycles=%d\n", soh, cycles);
}

// 注册子系统
static const struct bsoh_sub_sys basp_sub_sys = {
    .sys_init = basp_init,
    .sys_exit = basp_exit,
    .event_notify = basp_event_notify,
    .dmd_prepare = basp_dmd_prepare,
    .type_name = "basp",
    .notify_node = "basp_data",
};

static int __init basp_module_init(void)
{
    bsoh_register_sub_sys(BSOH_SUB_SYS_BASP, &basp_sub_sys);
    return 0;
}
```

---

## 七、典型应用场景

### 场景 1：电池老化检测与上报

```c
// 1. BASP 子系统检测到电池老化
void basp_aging_check(void)
{
    int soh = calculate_soh();  // 计算 SOH
    
    if (soh < 80) {  // 健康度低于 80%
        // 发送 uevent 到用户空间
        char data[64];
        snprintf(data, sizeof(data), "soh=%d", soh);
        bsoh_uevent_rcv(BSOH_EVT_SOH_DCR_UPDATE, data);
        
        // 上报 DMD
        bsoh_dmd_append("basp", POWER_DSM_BATTERY_LOW_SOH);
    }
}
```

### 场景 2：内短路检测

```c
// 2. ISCD 子系统检测到内短路风险
void iscd_short_circuit_detect(void)
{
    int leakage_current = measure_leakage();
    
    if (leakage_current > THRESHOLD) {
        // 发送紧急 uevent
        bsoh_uevent_rcv(BSOH_EVT_BATT_INFO_UPDATE, 
            "status=short_circuit_risk");
        
        // 立即上报 DMD
        bsoh_dmd_append("iscd", POWER_DSM_BATTERY_SHORT_CIRCUIT);
    }
}
```

### 场景 3：多子系统联动

```c
// 3. 充电状态变化时通知所有子系统
void charging_event_handler(unsigned int event)
{
    // 广播事件到所有子系统
    bsoh_event_rcv(event);
    
    // 各子系统会收到通知：
    // - BASP: 更新充电循环计数
    // - ISCD: 检测充电异常
    // - ICM:  测量充电时阻抗
}
```

---

## 八、事件流程图

```
用户空间 (Android)
    ↑ uevent
    │
battery_soh.c (核心框架)
    ↑ 事件分发
    ├──→ BASP 子系统
    ├──→ ISCD 子系统
    ├──→ CFSD 子系统
    └──→ ICM 子系统
         ↓ 检测异常
    DMD 上报队列
         ↓ 延迟工作队列
    DSM 服务器
```

---

## 九、DMD 上报流程图

```
子系统检测异常
    ↓
bsoh_dmd_append(type, dmd_no)
    ↓
创建 DMD 条目 → 添加到链表
    ↓
调度延迟工作队列 (3秒)
    ↓
bsoh_dmd_work()
    ↓
遍历链表 → 调用 prepare()
    ↓
power_dsm_report_dmd()
    ↓
上报成功？
├─ 是 → 删除条目
└─ 否 → retry_times++
    ↓
超过 3 次重试？
├─ 是 → 删除条目
└─ 否 → 3秒后重试
```

---

## 十、关键宏定义

```c
BSOH_MAX_DMD_BUF_SIZE         1024   // DMD 缓冲区大小
BSOH_MAX_DMD_REPORT_TIMES     3      // DMD 最大重试次数
BSOH_MAX_RD_BUF_SIZE          64     // 读缓冲区大小
BSOH_EVENT_NOTIFY_SIZE        1024   // uevent 缓冲区大小
RSV_END_SPACE                 2      // 预留结束空间
```

---

## 十一、Sysfs 节点路径

```bash
/sys/devices/platform/battery-soh/
├── bsoh_battery_removed  (R, 0444) - 电池更换标志
├── bsoh_subsys           (R, 0444) - 已使能子系统列表
├── bsoh_dmd_report       (W, 0220) - DMD 上报触发
└── bsoh_sysfs_notify     (W, 0220) - Sysfs 通知触发 (DEBUG)
```

---

## 十二、调试方法

### 1. **查看使能的子系统**
```bash
cat /sys/devices/platform/battery-soh/bsoh_subsys
# 输出: basp,iscd,icm
```

### 2. **检查电池是否更换**
```bash
cat /sys/devices/platform/battery-soh/bsoh_battery_removed
# 输出: 0 (未更换) 或 1 (已更换)
```

### 3. **手动触发 DMD 上报**
```bash
echo "basp 920003001" > /sys/devices/platform/battery-soh/bsoh_dmd_report
dmesg | grep battery_soh
```

### 4. **监听 uevent**
```bash
# 监听电池健康度事件
udevadm monitor --property | grep BSOH_EVT
```

### 5. **查看日志**
```bash
dmesg | grep battery_soh
dmesg | grep BASP
dmesg | grep ISCD
```

---

## 十三、模块依赖

```
battery_soh.c (核心框架)
├── power_event (事件通知)
│   ├── power_event_report_uevent()
│   └── power_event_notify_sysfs()
├── power_dsm (DSM 上报)
│   └── power_dsm_report_dmd()
├── power_platform (平台接口)
│   └── power_platform_is_battery_changed()
└── 子系统模块
    ├── BASP (电池老化预测)
    ├── ISCD (内短路检测)
    ├── CFSD (电芯失效检测)
    └── ICM  (阻抗计算)
```

---

**总结**：`battery_soh` 是电池健康度管理的核心框架，采用插件式架构，支持多个独立子系统协同工作。通过统一的事件分发、DMD 上报和 Sysfs 接口，提供了灵活且可扩展的电池健康度监控解决方案。其设计思想体现了**高内聚、低耦合**的软件工程原则。