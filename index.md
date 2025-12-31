---
layout: home

hero:
  name: "Linux 内核笔记"
  text: "探索内核的奥秘"
  tagline: 记录工作中的 Linux 内核学习之路，从内存管理到 ARM 架构
  actions:
    - theme: brand
      text: 开始阅读
      link: /getting-started
    - theme: alt
      text: 内存管理专题
      link: /memory/overview

features:
  - icon: 🧠
    title: Linux 内存管理
    details: 深入理解内存分配、页表管理、Buddy 系统、Slab 分配器、内存回收机制、PSI 指标等核心概念
  - icon: ⚡
    title: ARM 架构与指令集
    details: 从 ARMv8/v9 架构基础到 TrustZone、GIC、MMU/Cache、AXI 总线等硬件特性的系统学习
  - icon: 🔧
    title: 系统稳定性分析
    details: 掌握 Trace32 调试工具、内核崩溃分析、性能优化、Android LMK 机制等实战技能
  - icon: 📚
    title: Cgroup 与资源隔离
    details: 深入学习 Cgroup v1/v2、Memcg、资源限制与容器化技术的底层实现
  - icon: 💾
    title: 内核启动与初始化
    details: 剖析 start_kernel 启动流程、Memblock 内存管理、Buddy 系统初始化等关键路径
  - icon: 🚀
    title: 高性能优化
    details: DMA、零拷贝、Page Cache、Buffer Cache 等高性能 I/O 技术深度解析
---

## 📖 关于本站

这是我在工作中学习 Linux 内核的笔记集合，主要涵盖以下几个方面：

- **内存管理子系统**：从基础概念到源码实现的完整学习路径
- **ARM 架构**：处理器架构、指令集、硬件特性的深入研究
- **系统稳定性**：调试工具、问题分析、性能优化的实践经验

## 🎯 学习路线

### 初级阶段
1. Linux 内存管理基础概念
2. 内存分布与页表管理
3. Buddy 系统与 Slab 分配器入门

### 中级阶段
1. 内存回收机制（kswapd、直接回收）
2. Cgroup 资源隔离与限制
3. ARM 架构基础与 MMU/Cache

### 高级阶段
1. 内核性能优化与调优
2. 内核崩溃分析与 Trace32 调试
3. Android 内存管理机制（LMK、PSI）

## 🔗 快速导航

- [Linux 内存管理系列文章](/memory/overview)
- [ARM 架构学习笔记](/arm/overview)
- [稳定性分析与调试](/stability/overview)
- [工具与实践](/tools/overview)

---

> 💡 **持续更新中** - 记录每一次学习的收获与思考

