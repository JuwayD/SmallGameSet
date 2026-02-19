const PREFIXES = [
    "宇宙", "金轮", "红河", "量子", "繁星", "远见", "聚能", "恒信", "中兴", "盛世",
    "蓝海", "云端", "极光", "天成", "瑞祥", "龙腾", "虎跃", "新动力", "华夏", "神州",
    "未来", "拓扑", "智芯", "超越", "绿地", "鼎泰", "合纵", "连横", "泰山", "长城"
];

const SUFFIXES = [
    "重工", "生物", "科技", "电力", "矿业", "软件", "地产", "物流", "制药", "新能源",
    "航天", "化工", "金融", "食品", "农业", "传媒", "网络", "光伏", "半导体", "新材料",
    "电机", "电能", "精密", "仪器", "建材", "港口", "基建", "保险", "证券", "贸易"
];

// 12 大行业分类映射 (V7 扩展)
export const SECTOR_MAP: Record<string, string> = {
    "科技": "科技", "软件": "科技", "航天": "科技", "网络": "科技",
    "半导体": "半导体", "芯片": "半导体",
    "工业": "工业", "重工": "工业", "智芯": "科技", // 修正智芯归属
    "机械": "工业", "制造": "工业", "电机": "工业", "精密": "工业", "仪器": "工业",
    "金融": "金融", "银行": "金融", "证券": "金融", "保险": "金融",
    "医疗": "医疗", "生物": "医疗", "制药": "医疗", "健康": "医疗",
    "消费": "消费", "零售": "消费", "食品": "消费", "电商": "消费", "贸易": "消费",
    "能源": "能源", "电力": "能源", "石油": "能源", "光伏": "能源", "电能": "能源", "化工": "能源",
    "房地产": "房地产", "地产": "房地产",
    "建筑": "建筑", "建材": "建筑", "基建": "建筑",
    "农业": "农业", "种业": "农业", "养殖": "农业",
    "军工": "军工", "防务": "军工",
    "交通": "交通", "物流": "交通", "航运": "交通", "港口": "交通",
    "智能": "科技", "新材料": "科技"
};

// 行业关联矩阵：Key 行业涨跌会滞后影响 Value 行业 (联动系数)
export const SECTOR_SYNERGY: Record<string, { target: string, coefficient: number }[]> = {
    "房地产": [{ target: "建筑", coefficient: 0.35 }, { target: "金融", coefficient: 0.2 }],
    "建筑": [{ target: "工业", coefficient: 0.25 }],
    "科技": [{ target: "半导体", coefficient: 0.45 }, { target: "消费", coefficient: 0.15 }],
    "半导体": [{ target: "科技", coefficient: 0.3 }],
    "能源": [{ target: "工业", coefficient: 0.3 }, { target: "交通", coefficient: 0.2 }],
    "金融": [{ target: "房地产", coefficient: 0.3 }, { target: "消费", coefficient: 0.1 }],
    "农业": [{ target: "消费", coefficient: 0.4 }],
    "军工": [{ target: "科技", coefficient: 0.25 }, { target: "工业", coefficient: 0.15 }],
    "交通": [{ target: "消费", coefficient: 0.25 }],
};

export interface MarketEvent {
    id: string;
    message: string;
    impact?: number;
    duration: number;
    targetType: "index" | "sector" | "all" | "buyLimit" | "tempBan";
    targetValue?: any;
    limitChange?: number;
}

const POTENTIAL_EVENTS: any[] = [
    // 宏观/指数事件
    { message: "【全球降息】全球央行步调一致开启宽松周期，市场流动性预期显著增强。", impact: 1.10, duration: 4, targetType: "all" },
    { message: "【避险升温】地缘局势风云突变，避险情绪如黑云压城，全行业估值中枢下行。", impact: 0.92, duration: 3, targetType: "all" },

    // 行业联动事件
    { message: "【产能瓶颈】{sector} 关键原材料供应发生断裂，下游产业链面临严峻的交付考验。", impact: 0.85, duration: 2, targetType: "sector", targetValue: "半导体" },
    { message: "【政策东风】国家级产业基金宣布入场，{sector} 及其配套产业被注入强心针。", impact: 1.12, duration: 5, targetType: "sector", targetValue: "科技" },
    { message: "【楼市变局】监管层释放信贷宽松信号，{sector} 及上下游关联行业交易热度骤升。", impact: 1.15, duration: 3, targetType: "sector", targetValue: "房地产" },
    { message: "【技术奇点】新一代能源转换协议签署，{sector} 迎来效率革命，全工业成本面临重构。", impact: 1.20, duration: 4, targetType: "sector", targetValue: "能源" },
    { message: "【防御需求】国际冲突加剧导致防务预算激增，{sector} 核心配套企业获大额采购合同。", impact: 1.18, duration: 3, targetType: "sector", targetValue: "军工" },

    // 行业利好
    { message: "【基本面逆转】{sector} 板块库存出清完毕，龙头企业盈利预期获机构大幅上调。", impact: 1.08, duration: 4, targetType: "sector" },
    { message: "【资本狂潮】海外养老基金宣布增持 {sector} 板块，大宗交易活跃度创历史新高。", impact: 1.15, duration: 2, targetType: "sector" },
    { message: "【消费浪潮】假日经济带动零售总额超预期，{sector} 板块业绩弹性全面爆发。", impact: 1.08, duration: 2, targetType: "sector", targetValue: "消费" },
    { message: "【丰收预期】全球核心产区迎来极佳天气，{sector} 市场供给充裕，下游成本压力缓解。", impact: 1.06, duration: 3, targetType: "sector", targetValue: "农业" },
    { message: "【集采余波】新一轮行业标准强制执行，{sector} 中小参与者面临清算风险。", impact: 0.80, duration: 4, targetType: "sector", targetValue: "医疗" },
    { message: "【航段阻断】某关键贸易航线因突发事故紧急封闭，{sector} 运力缺口持续扩大。", impact: 1.10, duration: 2, targetType: "sector", targetValue: "交通" },

    // 个股深度逻辑
    { message: "【产业协同】{name} 宣布与跨国巨头签署战略结盟协议，协同效应引发市场遐想。", impact: 1.15, duration: 3, targetType: "index" },
    { message: "【官司乌云】{name} 陷入核心专利侵权纠纷，潜在的高额违约金令投资者离场。", impact: 0.75, duration: 5, targetType: "index" },
    { message: "【财务红灯】监管层对 {name} 出具问询函，市场对其资产真实性存疑。", impact: 0.65, duration: 2, targetType: "index" },
    { message: "【帅印交接】{name} 核心执行层突发人事变动，新老更迭导致市场观望情绪深厚。", impact: 0.85, duration: 3, targetType: "index" },

    // 停牌与限购
    { message: "【资产重组】{name} 筹划重大战略合并，监管部门已介入审批流程，市场静待复牌。", duration: 2, targetType: "tempBan", targetValue: "index" },
    { message: "【自查风暴】{sector} 板块爆发系统性信誉危机，监管要求全行业进行合规性停牌检测。", duration: 2, targetType: "tempBan", targetValue: "sector" },
    { message: "【过热警示】{sector} 交易拥挤度达历史极值，投机氛围浓烈，市场自我调节机制已触发。", duration: 4, targetType: "buyLimit", targetValue: "sector", limitChange: -4 },
];

export function generateStockNames(count: number): { name: string, sector: string, shares: number }[] {
    const results: { name: string, sector: string, shares: number }[] = [];
    const usedNames = new Set<string>();
    while (results.length < count) {
        const pre = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
        const suf = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];
        const name = `${pre}${suf}`;
        if (!usedNames.has(name)) {
            usedNames.add(name);
            // 随机分配初始股本：10万 - 100万股
            const shares = 100000 + Math.floor(Math.random() * 90) * 10000;
            results.push({ name, sector: SECTOR_MAP[suf] || "其他", shares });
        }
    }
    return results;
}

export function generateEvent(stocks: any[]): MarketEvent | null {
    if (Math.random() > 0.28) return null;

    const raw = POTENTIAL_EVENTS[Math.floor(Math.random() * POTENTIAL_EVENTS.length)];
    let msg = raw.message;
    let targetValue: any = null;

    if (raw.targetType === "index") {
        const idx = Math.floor(Math.random() * stocks.length);
        msg = msg.replace("{name}", stocks[idx].name);
        targetValue = idx;
    } else if (raw.targetType === "sector") {
        const targetSector = raw.targetValue;
        if (targetSector && targetSector !== "sector") {
            msg = msg.replace("{sector}", targetSector);
            targetValue = targetSector;
        } else {
            const sectors = Array.from(new Set(stocks.map(s => s.sector)));
            const sec = sectors[Math.floor(Math.random() * sectors.length)];
            msg = msg.replace("{sector}", sec);
            targetValue = sec;
        }
    } else if (raw.targetType === "buyLimit" || raw.targetType === "tempBan") {
        if (raw.targetValue === "index") {
            const idx = Math.floor(Math.random() * stocks.length);
            msg = msg.replace("{name}", stocks[idx].name);
            targetValue = { type: "index", value: idx };
        } else if (raw.targetValue === "sector") {
            const sectors = Array.from(new Set(stocks.map(s => s.sector)));
            const sec = sectors[Math.floor(Math.random() * sectors.length)];
            msg = msg.replace("{sector}", sec);
            targetValue = { type: "sector", value: sec };
        } else if (raw.targetValue) {
            msg = msg.replace("{sector}", raw.targetValue);
            targetValue = { type: "sector", value: raw.targetValue };
        }
    }

    const event: any = {
        id: Math.random().toString(36).substring(7),
        message: msg,
        impact: raw.impact,
        duration: raw.duration,
        targetType: raw.targetType,
        targetValue: targetValue,
        limitChange: raw.limitChange,
    };

    Object.keys(event).forEach(key => { if (event[key] === undefined) delete event[key]; });
    return event;
}

export function simulatePrice(currentPrice: number, multipliers: number[] = [], volatility: number = 0.15, marketCap: number = 5000000): number {
    const drift = 0.005;
    const eventMultiplier = multipliers.reduce((acc, m) => acc * m, 1);

    // 市值稳定性因子：以 500万 为基准，每增加一个量级，波动率衰减，但最小保留 0.04
    const stability = Math.max(0.3, Math.min(1.0, 5000000 / marketCap));
    const effectiveVolatility = volatility * stability;

    const change = (Math.random() - 0.45) * 2 * effectiveVolatility;
    let nextPrice = currentPrice * (1 + drift + change) * eventMultiplier;
    nextPrice = Math.round(nextPrice * 100) / 100;
    return Math.max(0.1, nextPrice);
}

export function getPriceColor(change: number): string {
    if (change > 0) return "#ef4444";
    if (change < 0) return "#22c55e";
    return "#9ca3af";
}
