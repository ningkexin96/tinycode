---
name: triage-sop
description: 工单分流标准流程：取单 → 查知识库 → 判定分类/优先级/意图 → 分流。处理任何工单前先加载本 SOP。
---
# 工单分流 SOP

1. 用 `list_tickets` 盘点待处理工单；用 `get_ticket` 读取目标工单全文（会话 + 备注）。
2. 用 `search_knowledge` 定位相关政策，再用 `read_article` 读取原文 —— 不要凭记忆判定。
3. 用 `classify_ticket` 落盘分类、优先级与意图；一条工单只归一个主分类。
4. 依据政策与各队列职责，用 `route_ticket` 分流，并在理由里写清依据（引用命中的文章 id）。
5. 若发现知识库与现行政策不一致，用 `propose_knowledge_edit` 提出精确修正（必须人工审批后再落盘）。

## 判定要点

- 先看 SLA：`createdAt + slaMinutes` 已过期的工单优先级至少 P1。
- 退款类工单必须先核对订单是否已发货，再决定退款或补发。
- 涉及金额、身份、风险三类特征的，另外参考 `escalation-rules` 技能。
