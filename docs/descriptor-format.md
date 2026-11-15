# 描述符范围

位流采用网络位序；两组 stationBlock 连续排列，剩余末尾位必须是零填充。温度实际值为 (无符号原值+reference) × 10^-scale。element 全一位型表示 missing。replication 先读 factor，再按次数读 members；sequence 和 operator 嵌套作用域互不泄漏。未知描述符使依赖它的后续位偏移未确定，不允许猜跳过。
