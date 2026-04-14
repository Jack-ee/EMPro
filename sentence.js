/**
 * sentence.js — Advanced English Sentence Practice
 *
 * Contexts: academic writing, research collaboration, code review,
 *           professional communication, data analysis
 *
 * Each sentence targets 2-4 words that advanced learners commonly
 * struggle with in professional/academic English.
 */

window.CUSTOM_SENTENCES = [

    // ═══════════════════════════════════════════════════════════
    //  ACADEMIC WRITING — Paper structure and argumentation
    // ═══════════════════════════════════════════════════════════

    {
        id: 1,
        sentence_en: "This study addresses a critical gap in the literature by providing the first comprehensive assessment of rubber plantation expansion across tropical Asia.",
        sentence_cn: "本研究通过提供热带亚洲橡胶种植园扩张的首次综合评估，填补了文献中的一个关键空白。",
        targets: [
            { word: "addresses",     phonetic: "/əˈdresɪz/",       meaning: "解决; 处理",         collo: "addresses a gap" },
            { word: "comprehensive", phonetic: "/ˌkɒmprɪˈhensɪv/", meaning: "全面的; 综合的",     collo: "comprehensive assessment" },
            { word: "expansion",     phonetic: "/ɪkˈspænʃən/",     meaning: "扩张; 扩展",         collo: "rapid expansion" }
        ],
        options_pool: ["addresses", "comprehensive", "expansion", "resolves", "thorough", "extension", "tackles", "complete", "growth"]
    },

    {
        id: 2,
        sentence_en: "The findings reveal substantial heterogeneity in planting patterns across provinces, which can be attributed to regional policy differences.",
        sentence_cn: "研究结果揭示了各省种植模式的显著异质性，这可归因于地区政策差异。",
        targets: [
            { word: "substantial",   phonetic: "/səbˈstænʃəl/",    meaning: "大量的; 实质性的",   collo: "substantial difference" },
            { word: "heterogeneity", phonetic: "/ˌhetərədʒəˈniːəti/", meaning: "异质性; 不均匀性", collo: "spatial heterogeneity" },
            { word: "attributed",    phonetic: "/əˈtrɪbjuːtɪd/",   meaning: "归因于",             collo: "attributed to" }
        ],
        options_pool: ["substantial", "heterogeneity", "attributed", "significant", "diversity", "assigned", "considerable", "variation", "caused"]
    },

    {
        id: 3,
        sentence_en: "Previous studies have predominantly relied on pixel-based classification methods, which are inherently limited in capturing spatial context.",
        sentence_cn: "以往的研究主要依赖基于像元的分类方法，这些方法在捕获空间上下文方面存在固有的局限性。",
        targets: [
            { word: "predominantly", phonetic: "/prɪˈdɒmɪnəntli/", meaning: "主要地; 占主导地", collo: "predominantly used" },
            { word: "inherently",    phonetic: "/ɪnˈhɪərəntli/",   meaning: "固有地; 本质上",   collo: "inherently limited" },
            { word: "capturing",     phonetic: "/ˈkæptʃərɪŋ/",     meaning: "捕获; 捕捉",       collo: "capturing patterns" }
        ],
        options_pool: ["predominantly", "inherently", "capturing", "mainly", "fundamentally", "detecting", "largely", "essentially", "extracting"]
    },

    {
        id: 4,
        sentence_en: "We hypothesize that the observed lag between rubber price peaks and planting surges reflects the time required for seedling procurement and land preparation.",
        sentence_cn: "我们假设观察到的橡胶价格峰值与种植高峰之间的滞后，反映了苗木采购和土地准备所需的时间。",
        targets: [
            { word: "hypothesize", phonetic: "/haɪˈpɒθəsaɪz/", meaning: "假设; 假定",       collo: "hypothesize that" },
            { word: "lag",         phonetic: "/læɡ/",           meaning: "滞后; 延迟",       collo: "time lag" },
            { word: "procurement", phonetic: "/prəˈkjʊəmənt/",  meaning: "采购; 获取",       collo: "procurement process" }
        ],
        options_pool: ["hypothesize", "lag", "procurement", "assume", "delay", "purchasing", "speculate", "gap", "acquisition"]
    },

    {
        id: 5,
        sentence_en: "The methodology was validated against high-resolution imagery, yielding an overall accuracy of 92.3% with a kappa coefficient of 0.89.",
        sentence_cn: "该方法通过高分辨率影像进行了验证，总体精度为92.3%，kappa系数为0.89。",
        targets: [
            { word: "validated",   phonetic: "/ˈvælɪdeɪtɪd/",  meaning: "验证; 确认",     collo: "validated against" },
            { word: "yielding",    phonetic: "/ˈjiːldɪŋ/",     meaning: "产生; 给出",     collo: "yielding results" },
            { word: "coefficient", phonetic: "/ˌkəʊɪˈfɪʃənt/", meaning: "系数",           collo: "correlation coefficient" }
        ],
        options_pool: ["validated", "yielding", "coefficient", "verified", "producing", "parameter", "confirmed", "generating", "index"]
    },

    {
        id: 6,
        sentence_en: "These discrepancies warrant further investigation, particularly regarding the sensitivity of the algorithm to cloud contamination in tropical regions.",
        sentence_cn: "这些差异值得进一步研究，特别是关于算法对热带地区云污染的敏感性。",
        targets: [
            { word: "discrepancies", phonetic: "/dɪˈskrepənsiz/",  meaning: "差异; 不一致",     collo: "resolve discrepancies" },
            { word: "warrant",       phonetic: "/ˈwɒrənt/",        meaning: "值得; 需要",       collo: "warrant investigation" },
            { word: "sensitivity",   phonetic: "/ˌsensɪˈtɪvɪti/",  meaning: "敏感性; 灵敏度",   collo: "sensitivity analysis" }
        ],
        options_pool: ["discrepancies", "warrant", "sensitivity", "differences", "deserve", "susceptibility", "inconsistencies", "require", "vulnerability"]
    },

    {
        id: 7,
        sentence_en: "Our approach leverages the temporal embedding similarity to discriminate between mature rubber plantations and other evergreen vegetation.",
        sentence_cn: "我们的方法利用时间嵌入相似度来区分成熟橡胶种植园和其他常绿植被。",
        targets: [
            { word: "leverages",    phonetic: "/ˈlevərɪdʒɪz/",  meaning: "利用; 借助",       collo: "leverages technology" },
            { word: "discriminate", phonetic: "/dɪˈskrɪmɪneɪt/", meaning: "区分; 辨别",       collo: "discriminate between" },
            { word: "vegetation",   phonetic: "/ˌvedʒɪˈteɪʃən/", meaning: "植被",             collo: "vegetation cover" }
        ],
        options_pool: ["leverages", "discriminate", "vegetation", "utilizes", "distinguish", "greenery", "exploits", "separate", "canopy"]
    },

    {
        id: 8,
        sentence_en: "The manuscript has been substantially revised to incorporate the reviewers' constructive feedback and address all outstanding concerns.",
        sentence_cn: "手稿已进行了大幅修改，以纳入审稿人的建设性反馈意见并解决所有未决问题。",
        targets: [
            { word: "substantially", phonetic: "/səbˈstænʃəli/",     meaning: "大幅地; 实质性地", collo: "substantially revised" },
            { word: "incorporate",   phonetic: "/ɪnˈkɔːpəreɪt/",    meaning: "纳入; 包含",       collo: "incorporate feedback" },
            { word: "outstanding",   phonetic: "/aʊtˈstændɪŋ/",     meaning: "未解决的; 突出的", collo: "outstanding issues" }
        ],
        options_pool: ["substantially", "incorporate", "outstanding", "significantly", "integrate", "remaining", "considerably", "include", "unresolved"]
    },

    // ═══════════════════════════════════════════════════════════
    //  RESEARCH COLLABORATION — Meetings, emails, discussion
    // ═══════════════════════════════════════════════════════════

    {
        id: 9,
        sentence_en: "Before we proceed with the analysis, I'd like to discuss how to determine the optimal time intervals for grouping the data.",
        sentence_cn: "在进行分析之前，我想讨论一下如何确定数据分组的最佳时间区间。",
        targets: [
            { word: "proceed",  phonetic: "/prəˈsiːd/",  meaning: "继续; 进行", collo: "proceed with" },
            { word: "determine", phonetic: "/dɪˈtɜːmɪn/", meaning: "确定; 决定", collo: "determine the cause" },
            { word: "optimal",  phonetic: "/ˈɒptɪməl/",  meaning: "最优的; 最佳的", collo: "optimal solution" }
        ],
        options_pool: ["proceed", "determine", "optimal", "continue", "identify", "best", "advance", "establish", "ideal"]
    },

    {
        id: 10,
        sentence_en: "We need to consolidate the research gaps to avoid listing too many, and confirm whether our study actually addresses them.",
        sentence_cn: "我们需要整合研究空白以避免列举太多，并确认我们的研究是否真正解决了这些问题。",
        targets: [
            { word: "consolidate", phonetic: "/kənˈsɒlɪdeɪt/", meaning: "整合; 合并",     collo: "consolidate resources" },
            { word: "confirm",     phonetic: "/kənˈfɜːm/",     meaning: "确认; 证实",     collo: "confirm the results" },
            { word: "addresses",   phonetic: "/əˈdresɪz/",     meaning: "解决; 针对",     collo: "addresses the issue" }
        ],
        options_pool: ["consolidate", "confirm", "addresses", "merge", "verify", "solves", "combine", "validate", "tackles"]
    },

    {
        id: 11,
        sentence_en: "Your intuition is spot-on — the mismatch between the two datasets is the red flag we should investigate first.",
        sentence_cn: "你的直觉非常准确——两个数据集之间的不匹配正是我们应该首先调查的危险信号。",
        targets: [
            { word: "intuition", phonetic: "/ˌɪntjuˈɪʃən/", meaning: "直觉",             collo: "trust your intuition" },
            { word: "mismatch",  phonetic: "/ˌmɪsˈmætʃ/",   meaning: "不匹配; 不一致",   collo: "data mismatch" },
            { word: "investigate", phonetic: "/ɪnˈvestɪɡeɪt/", meaning: "调查; 研究",     collo: "investigate further" }
        ],
        options_pool: ["intuition", "mismatch", "investigate", "instinct", "discrepancy", "examine", "feeling", "inconsistency", "explore"]
    },

    {
        id: 12,
        sentence_en: "I noticed you set the sampling scale to 90 meters for speed — should we switch to native resolution if it doesn't time out?",
        sentence_cn: "我注意到你把采样尺度设成了90米以提高速度——如果不超时的话，我们是否应该切换到原始分辨率？",
        targets: [
            { word: "noticed",    phonetic: "/ˈnəʊtɪst/",    meaning: "注意到",         collo: "I noticed that" },
            { word: "resolution", phonetic: "/ˌrezəˈluːʃən/", meaning: "分辨率; 解决",   collo: "spatial resolution" },
            { word: "switch",     phonetic: "/swɪtʃ/",        meaning: "切换; 转换",     collo: "switch between" }
        ],
        options_pool: ["noticed", "resolution", "switch", "observed", "accuracy", "change", "saw", "precision", "convert"]
    },

    {
        id: 13,
        sentence_en: "Could you rewrite my Introduction to remove any obvious AI-like phrasing and bold the sentences you changed so I can spot them quickly?",
        sentence_cn: "你能重写我的引言，去掉任何明显的AI风格用语，并加粗你修改的句子，以便我快速找到它们吗？",
        targets: [
            { word: "obvious",  phonetic: "/ˈɒbviəs/",  meaning: "明显的",         collo: "obvious difference" },
            { word: "phrasing", phonetic: "/ˈfreɪzɪŋ/", meaning: "措辞; 表达方式", collo: "natural phrasing" },
            { word: "spot",     phonetic: "/spɒt/",      meaning: "发现; 找到",     collo: "spot the difference" }
        ],
        options_pool: ["obvious", "phrasing", "spot", "evident", "wording", "find", "apparent", "expression", "identify"]
    },

    {
        id: 14,
        sentence_en: "This paragraph doesn't flow smoothly from the previous one — the transition feels abrupt and the reader might get confused.",
        sentence_cn: "这一段和前一段之间衔接不流畅——过渡感觉很突兀，读者可能会感到困惑。",
        targets: [
            { word: "smoothly",   phonetic: "/ˈsmuːðli/",  meaning: "流畅地; 顺利地", collo: "flow smoothly" },
            { word: "transition",  phonetic: "/trænˈzɪʃən/", meaning: "过渡; 转换",   collo: "smooth transition" },
            { word: "abrupt",     phonetic: "/əˈbrʌpt/",    meaning: "突然的; 唐突的", collo: "abrupt change" }
        ],
        options_pool: ["smoothly", "transition", "abrupt", "naturally", "connection", "sudden", "fluently", "shift", "sharp"]
    },

    {
        id: 15,
        sentence_en: "Let's repeat the same kind of manuscript-level critique on this paper, then craft a strong search prompt to find supporting references.",
        sentence_cn: "让我们对这篇论文进行同样的稿件级别评审，然后设计一个好的检索提示来找到支持性文献。",
        targets: [
            { word: "critique",   phonetic: "/krɪˈtiːk/",  meaning: "评论; 批评",     collo: "constructive critique" },
            { word: "craft",      phonetic: "/krɑːft/",     meaning: "精心制作; 设计", collo: "craft a message" },
            { word: "references", phonetic: "/ˈrefərənsɪz/", meaning: "参考文献",     collo: "supporting references" }
        ],
        options_pool: ["critique", "craft", "references", "review", "design", "citations", "analysis", "build", "literature"]
    },

    // ═══════════════════════════════════════════════════════════
    //  CODE REVIEW & TECHNICAL DISCUSSION
    // ═══════════════════════════════════════════════════════════

    {
        id: 16,
        sentence_en: "Please refactor this workflow to rely on our existing module APIs as much as possible and delete any helper functions that become redundant.",
        sentence_cn: "请重构此工作流程，尽可能依赖我们现有的模块API，并删除任何变得多余的辅助函数。",
        targets: [
            { word: "refactor",  phonetic: "/riːˈfæktər/",  meaning: "重构",             collo: "refactor the code" },
            { word: "redundant", phonetic: "/rɪˈdʌndənt/",  meaning: "多余的; 冗余的",   collo: "redundant code" },
            { word: "existing",  phonetic: "/ɪɡˈzɪstɪŋ/",   meaning: "现有的; 已存在的", collo: "existing system" }
        ],
        options_pool: ["refactor", "redundant", "existing", "rewrite", "unnecessary", "current", "restructure", "duplicate", "available"]
    },

    {
        id: 17,
        sentence_en: "What if we merged the bands first and then called reduceRegion once — would this significantly speed up the computation?",
        sentence_cn: "如果我们先合并波段，然后只调用一次reduceRegion——这会显著加速计算吗？",
        targets: [
            { word: "merged",        phonetic: "/mɜːdʒd/",          meaning: "合并",               collo: "merged together" },
            { word: "significantly", phonetic: "/sɪɡˈnɪfɪkəntli/",  meaning: "显著地",             collo: "significantly improve" },
            { word: "computation",   phonetic: "/ˌkɒmpjuˈteɪʃən/",  meaning: "计算",               collo: "computational cost" }
        ],
        options_pool: ["merged", "significantly", "computation", "combined", "substantially", "processing", "joined", "considerably", "calculation"]
    },

    {
        id: 18,
        sentence_en: "Here's the current script with all the debugging code — can you clean it up and create a production version that focuses on the key analyses?",
        sentence_cn: "这是当前包含所有调试代码的脚本——你能清理一下并创建一个专注于关键分析的生产版本吗？",
        targets: [
            { word: "debugging",  phonetic: "/diːˈbʌɡɪŋ/",    meaning: "调试",         collo: "debugging code" },
            { word: "production", phonetic: "/prəˈdʌkʃən/",    meaning: "生产; 正式的", collo: "production version" },
            { word: "focuses",    phonetic: "/ˈfəʊkəsɪz/",     meaning: "专注于",       collo: "focuses on" }
        ],
        options_pool: ["debugging", "production", "focuses", "testing", "deployment", "concentrates", "development", "release", "targets"]
    },

    {
        id: 19,
        sentence_en: "We should strip out anything irrelevant for now and create a simple script just to verify the edge detection works correctly.",
        sentence_cn: "我们应该暂时去掉所有无关的内容，创建一个简单的脚本来验证边缘检测是否正常工作。",
        targets: [
            { word: "strip",    phonetic: "/strɪp/",     meaning: "去掉; 剥离",     collo: "strip out" },
            { word: "irrelevant", phonetic: "/ɪˈreləvənt/", meaning: "无关的; 不相关的", collo: "irrelevant information" },
            { word: "verify",   phonetic: "/ˈverɪfaɪ/",  meaning: "验证; 核实",     collo: "verify the results" }
        ],
        options_pool: ["strip", "irrelevant", "verify", "remove", "unnecessary", "confirm", "delete", "unrelated", "validate"]
    },

    {
        id: 20,
        sentence_en: "I'd like rich docstrings with usage demos for the export APIs — prefer not wrapping text unless a single line is extremely long.",
        sentence_cn: "我想要带有使用示例的详细文档字符串用于导出API——除非单行特别长，否则尽量不换行。",
        targets: [
            { word: "docstrings", phonetic: "/ˈdɒkstrɪŋz/", meaning: "文档字符串",     collo: "write docstrings" },
            { word: "demos",      phonetic: "/ˈdeməʊz/",     meaning: "演示; 示例",     collo: "usage demos" },
            { word: "wrapping",   phonetic: "/ˈræpɪŋ/",      meaning: "换行; 包裹",     collo: "line wrapping" }
        ],
        options_pool: ["docstrings", "demos", "wrapping", "comments", "examples", "breaking", "documentation", "samples", "folding"]
    },

    // ═══════════════════════════════════════════════════════════
    //  PROFESSIONAL COMMUNICATION — Emails, presentations
    // ═══════════════════════════════════════════════════════════

    {
        id: 21,
        sentence_en: "I appreciate your flexibility on the deadline — would it be feasible to schedule a brief meeting to align on the remaining deliverables?",
        sentence_cn: "感谢您在截止日期上的灵活性——是否可以安排一个简短的会议来就剩余的可交付成果达成一致？",
        targets: [
            { word: "flexibility",  phonetic: "/ˌfleksɪˈbɪlɪti/", meaning: "灵活性",           collo: "appreciate your flexibility" },
            { word: "feasible",     phonetic: "/ˈfiːzəbl/",        meaning: "可行的",           collo: "technically feasible" },
            { word: "deliverables", phonetic: "/dɪˈlɪvərəblz/",    meaning: "可交付成果",       collo: "key deliverables" }
        ],
        options_pool: ["flexibility", "feasible", "deliverables", "adaptability", "possible", "outputs", "openness", "practical", "milestones"]
    },

    {
        id: 22,
        sentence_en: "For what it's worth, I think we should prioritize the accuracy assessment before interpreting the map results.",
        sentence_cn: "仅供参考，我认为我们应该在解读地图结果之前优先进行精度评估。",
        targets: [
            { word: "prioritize",  phonetic: "/praɪˈɒrɪtaɪz/",  meaning: "优先处理",     collo: "prioritize tasks" },
            { word: "assessment",  phonetic: "/əˈsesmənt/",      meaning: "评估; 评价",   collo: "risk assessment" },
            { word: "interpreting", phonetic: "/ɪnˈtɜːprɪtɪŋ/", meaning: "解读; 解释",   collo: "interpreting results" }
        ],
        options_pool: ["prioritize", "assessment", "interpreting", "emphasize", "evaluation", "analyzing", "focus", "examination", "understanding"]
    },

    {
        id: 23,
        sentence_en: "The preliminary results are promising, but we need to exercise caution before drawing any definitive conclusions from such a small sample.",
        sentence_cn: "初步结果令人鼓舞，但在从如此小的样本中得出任何确定性结论之前，我们需要保持谨慎。",
        targets: [
            { word: "preliminary", phonetic: "/prɪˈlɪmɪnəri/",  meaning: "初步的; 预备的", collo: "preliminary results" },
            { word: "caution",     phonetic: "/ˈkɔːʃən/",       meaning: "谨慎; 小心",     collo: "exercise caution" },
            { word: "definitive",  phonetic: "/dɪˈfɪnɪtɪv/",    meaning: "确定的; 最终的", collo: "definitive answer" }
        ],
        options_pool: ["preliminary", "caution", "definitive", "initial", "prudence", "conclusive", "early", "care", "final"]
    },

    {
        id: 24,
        sentence_en: "I'd recommend running a sensitivity analysis to quantify how robust our findings are to variations in the input parameters.",
        sentence_cn: "我建议进行敏感性分析，以量化我们的发现对输入参数变化的稳健程度。",
        targets: [
            { word: "recommend", phonetic: "/ˌrekəˈmend/",   meaning: "建议; 推荐",       collo: "highly recommend" },
            { word: "quantify",  phonetic: "/ˈkwɒntɪfaɪ/",   meaning: "量化",             collo: "quantify the impact" },
            { word: "robust",    phonetic: "/rəʊˈbʌst/",     meaning: "稳健的; 强健的",   collo: "robust method" }
        ],
        options_pool: ["recommend", "quantify", "robust", "suggest", "measure", "stable", "advise", "calculate", "resilient"]
    },

    {
        id: 25,
        sentence_en: "Could you elaborate on how the algorithm handles edge cases, particularly where rubber plantations are adjacent to natural forests?",
        sentence_cn: "你能详细说明算法如何处理边缘情况吗，特别是橡胶种植园与天然林相邻的地方？",
        targets: [
            { word: "elaborate",   phonetic: "/ɪˈlæbəreɪt/",  meaning: "详细说明; 阐述", collo: "elaborate on" },
            { word: "adjacent",    phonetic: "/əˈdʒeɪsənt/",  meaning: "相邻的; 毗邻的", collo: "adjacent to" },
            { word: "particularly", phonetic: "/pəˈtɪkjələli/", meaning: "特别地; 尤其", collo: "particularly important" }
        ],
        options_pool: ["elaborate", "adjacent", "particularly", "explain", "neighboring", "especially", "clarify", "nearby", "specifically"]
    },

    // ═══════════════════════════════════════════════════════════
    //  DATA ANALYSIS & METHODOLOGY
    // ═══════════════════════════════════════════════════════════

    {
        id: 26,
        sentence_en: "The regression analysis indicates a statistically significant correlation between rubber prices and cumulative planting area with a two-year lag.",
        sentence_cn: "回归分析表明橡胶价格与累积种植面积之间存在统计学上显著的相关性，滞后两年。",
        targets: [
            { word: "indicates",   phonetic: "/ˈɪndɪkeɪts/",     meaning: "表明; 指出",     collo: "indicates that" },
            { word: "correlation", phonetic: "/ˌkɒrəˈleɪʃən/",   meaning: "相关性; 关联",   collo: "strong correlation" },
            { word: "cumulative",  phonetic: "/ˈkjuːmjələtɪv/",   meaning: "累积的",         collo: "cumulative effect" }
        ],
        options_pool: ["indicates", "correlation", "cumulative", "suggests", "relationship", "aggregate", "shows", "association", "accumulated"]
    },

    {
        id: 27,
        sentence_en: "We derived the terrain metrics from a 30-meter digital elevation model and stratified the analysis by slope gradient and aspect.",
        sentence_cn: "我们从30米数字高程模型中提取了地形指标，并按坡度梯度和坡向对分析进行了分层。",
        targets: [
            { word: "derived",     phonetic: "/dɪˈraɪvd/",     meaning: "得出; 推导",     collo: "derived from" },
            { word: "stratified",  phonetic: "/ˈstrætɪfaɪd/",  meaning: "分层的",         collo: "stratified sampling" },
            { word: "gradient",    phonetic: "/ˈɡreɪdiənt/",   meaning: "梯度; 坡度",     collo: "temperature gradient" }
        ],
        options_pool: ["derived", "stratified", "gradient", "extracted", "categorized", "slope", "obtained", "classified", "incline"]
    },

    {
        id: 28,
        sentence_en: "The algorithm iteratively refines cluster boundaries until convergence is achieved, typically within 15 to 20 iterations.",
        sentence_cn: "该算法迭代地优化聚类边界，直到达到收敛，通常在15到20次迭代内。",
        targets: [
            { word: "iteratively", phonetic: "/ˈɪtərətɪvli/",    meaning: "迭代地",         collo: "iteratively improve" },
            { word: "convergence", phonetic: "/kənˈvɜːdʒəns/",   meaning: "收敛; 汇聚",     collo: "reach convergence" },
            { word: "boundaries",  phonetic: "/ˈbaʊndəriz/",     meaning: "边界",           collo: "decision boundaries" }
        ],
        options_pool: ["iteratively", "convergence", "boundaries", "repeatedly", "stability", "edges", "progressively", "equilibrium", "limits"]
    },

    {
        id: 29,
        sentence_en: "Most of the classification error is outright misidentification of non-rubber vegetation, rather than confusion between rubber age classes.",
        sentence_cn: "大部分分类错误是对非橡胶植被的彻底误判，而不是橡胶龄级之间的混淆。",
        targets: [
            { word: "outright",   phonetic: "/ˈaʊtraɪt/",      meaning: "彻底的; 完全的", collo: "outright error" },
            { word: "confusion",  phonetic: "/kənˈfjuːʒən/",   meaning: "混淆; 困惑",     collo: "confusion matrix" },
            { word: "rather",     phonetic: "/ˈrɑːðər/",       meaning: "而不是; 宁可",   collo: "rather than" }
        ],
        options_pool: ["outright", "confusion", "rather", "complete", "mixing", "instead", "total", "overlap", "than"]
    },

    {
        id: 30,
        sentence_en: "The spatial resolution constrains our ability to detect smallholder plots, which are typically fragmented and interspersed with other crops.",
        sentence_cn: "空间分辨率限制了我们检测小农地块的能力，这些地块通常是碎片化的并与其他作物交错分布。",
        targets: [
            { word: "constrains",   phonetic: "/kənˈstreɪnz/",     meaning: "限制; 约束",       collo: "constrains the ability" },
            { word: "fragmented",   phonetic: "/ˈfræɡməntɪd/",     meaning: "碎片化的",         collo: "fragmented landscape" },
            { word: "interspersed", phonetic: "/ˌɪntəˈspɜːst/",    meaning: "散布的; 穿插的",   collo: "interspersed with" }
        ],
        options_pool: ["constrains", "fragmented", "interspersed", "limits", "scattered", "mixed", "restricts", "broken", "distributed"]
    },

    // ═══════════════════════════════════════════════════════════
    //  EVERYDAY PROFESSIONAL — Native phrasing
    // ═══════════════════════════════════════════════════════════

    {
        id: 31,
        sentence_en: "That was just my initial impression — there's no other specific reason behind it, so feel free to suggest alternatives.",
        sentence_cn: "那只是我的初步印象——没有其他特别的原因，所以请随意提出替代方案。",
        targets: [
            { word: "initial",      phonetic: "/ɪˈnɪʃəl/",      meaning: "最初的; 初步的", collo: "initial impression" },
            { word: "specific",     phonetic: "/spəˈsɪfɪk/",    meaning: "具体的; 特定的", collo: "specific reason" },
            { word: "alternatives", phonetic: "/ɔːlˈtɜːnətɪvz/", meaning: "替代方案",     collo: "suggest alternatives" }
        ],
        options_pool: ["initial", "specific", "alternatives", "first", "particular", "options", "preliminary", "certain", "choices"]
    },

    {
        id: 32,
        sentence_en: "I'll manually integrate your functions into my script and update the configuration myself — just focus on the core logic.",
        sentence_cn: "我会自己把你的函数整合到我的脚本里，自己更新配置——你只需专注于核心逻辑。",
        targets: [
            { word: "manually",      phonetic: "/ˈmænjuəli/",      meaning: "手动地",         collo: "manually adjust" },
            { word: "integrate",     phonetic: "/ˈɪntɪɡreɪt/",     meaning: "整合; 集成",     collo: "integrate into" },
            { word: "configuration", phonetic: "/kənˌfɪɡəˈreɪʃən/", meaning: "配置",           collo: "system configuration" }
        ],
        options_pool: ["manually", "integrate", "configuration", "personally", "incorporate", "settings", "myself", "merge", "parameters"]
    },

    {
        id: 33,
        sentence_en: "We've done the first cleanup pass — now we want a second round to remove isolated patches with no other rubber within two kilometers.",
        sentence_cn: "我们已经完成了第一次清理——现在我们想要第二轮，移除两公里内没有其他橡胶的孤立斑块。",
        targets: [
            { word: "cleanup",  phonetic: "/ˈkliːnʌp/",  meaning: "清理; 整理",     collo: "code cleanup" },
            { word: "isolated", phonetic: "/ˈaɪsəleɪtɪd/", meaning: "孤立的; 隔离的", collo: "isolated incident" },
            { word: "patches",  phonetic: "/ˈpætʃɪz/",    meaning: "斑块; 碎片",     collo: "small patches" }
        ],
        options_pool: ["cleanup", "isolated", "patches", "clearing", "remote", "fragments", "tidying", "scattered", "segments"]
    },

    {
        id: 34,
        sentence_en: "Before making any revisions, we should conduct a thorough self-review checking for logic, consistency, and whether our findings are presented appropriately.",
        sentence_cn: "在进行任何修改之前，我们应该进行彻底的自我审查，检查逻辑、一致性以及我们的发现是否表述恰当。",
        targets: [
            { word: "conduct",       phonetic: "/kənˈdʌkt/",       meaning: "进行; 实施",     collo: "conduct research" },
            { word: "thorough",      phonetic: "/ˈθʌrə/",          meaning: "彻底的; 详尽的", collo: "thorough review" },
            { word: "appropriately", phonetic: "/əˈprəʊpriətli/",  meaning: "恰当地; 适当地", collo: "appropriately cited" }
        ],
        options_pool: ["conduct", "thorough", "appropriately", "perform", "comprehensive", "properly", "carry", "detailed", "suitably"]
    },

    {
        id: 35,
        sentence_en: "The bottom line is that our accuracy exceeds the benchmark, but there is still room for improvement in the mountainous terrain classification.",
        sentence_cn: "最终结论是我们的精度超过了基准，但在山地地形分类方面仍有改进空间。",
        targets: [
            { word: "benchmark",   phonetic: "/ˈbentʃmɑːk/",   meaning: "基准; 标杆",     collo: "industry benchmark" },
            { word: "exceeds",     phonetic: "/ɪkˈsiːdz/",     meaning: "超过; 超越",     collo: "exceeds expectations" },
            { word: "improvement", phonetic: "/ɪmˈpruːvmənt/",  meaning: "改进; 提升",     collo: "room for improvement" }
        ],
        options_pool: ["benchmark", "exceeds", "improvement", "standard", "surpasses", "enhancement", "baseline", "outperforms", "progress"]
    },

    {
        id: 36,
        sentence_en: "Deliberating on the optimal table structure for the supplementary materials took longer than expected, but the result was much clearer.",
        sentence_cn: "考虑补充材料的最佳表格结构花了比预期更长的时间，但结果更加清晰。",
        targets: [
            { word: "deliberating",  phonetic: "/dɪˈlɪbəreɪtɪŋ/", meaning: "深思熟虑; 商议", collo: "deliberating on" },
            { word: "supplementary", phonetic: "/ˌsʌplɪˈmentəri/", meaning: "补充的",         collo: "supplementary materials" },
            { word: "expected",      phonetic: "/ɪkˈspektɪd/",     meaning: "预期的",         collo: "longer than expected" }
        ],
        options_pool: ["deliberating", "supplementary", "expected", "considering", "additional", "anticipated", "debating", "supporting", "predicted"]
    },

    {
        id: 37,
        sentence_en: "Since immature rubber mapping papers are scarce, should we broaden the literature search to include early identification methods for other perennial crops?",
        sentence_cn: "由于未成熟橡胶制图的论文很少，我们是否应该将文献搜索范围扩大到其他多年生作物的早期识别方法？",
        targets: [
            { word: "scarce",    phonetic: "/skeəs/",      meaning: "稀缺的; 稀少的", collo: "scarce resources" },
            { word: "broaden",   phonetic: "/ˈbrɔːdən/",   meaning: "拓宽; 扩大",     collo: "broaden the scope" },
            { word: "perennial", phonetic: "/pəˈreniəl/",  meaning: "多年生的; 长期的", collo: "perennial crops" }
        ],
        options_pool: ["scarce", "broaden", "perennial", "limited", "expand", "permanent", "rare", "widen", "evergreen"]
    },

    {
        id: 38,
        sentence_en: "Please reorganize the notebook so repeated variables are defined once and figure generation is clearly separated from data retrieval.",
        sentence_cn: "请重新组织笔记本，使重复的变量只定义一次，并将图形生成与数据检索明确分开。",
        targets: [
            { word: "reorganize", phonetic: "/riːˈɔːɡənaɪz/", meaning: "重新组织",       collo: "reorganize the code" },
            { word: "variables",  phonetic: "/ˈveəriəblz/",    meaning: "变量",           collo: "define variables" },
            { word: "separated",  phonetic: "/ˈsepəreɪtɪd/",   meaning: "分开的; 分离的", collo: "clearly separated" }
        ],
        options_pool: ["reorganize", "variables", "separated", "restructure", "parameters", "isolated", "rearrange", "constants", "divided"]
    },

    {
        id: 39,
        sentence_en: "The cumulative planting area exhibits a pronounced inflection point around 2008, coinciding with the global commodity price spike.",
        sentence_cn: "累积种植面积在2008年前后呈现一个明显的拐点，与全球大宗商品价格飙升相吻合。",
        targets: [
            { word: "exhibits",    phonetic: "/ɪɡˈzɪbɪts/",    meaning: "呈现; 展示",     collo: "exhibits a pattern" },
            { word: "pronounced",  phonetic: "/prəˈnaʊnst/",   meaning: "明显的; 显著的", collo: "pronounced effect" },
            { word: "coinciding",  phonetic: "/ˌkəʊɪnˈsaɪdɪŋ/", meaning: "同时发生; 吻合", collo: "coinciding with" }
        ],
        options_pool: ["exhibits", "pronounced", "coinciding", "shows", "notable", "overlapping", "displays", "marked", "aligning"]
    },

    {
        id: 40,
        sentence_en: "We acknowledge several limitations of this study, including the reliance on optical imagery which is susceptible to persistent cloud cover in the tropics.",
        sentence_cn: "我们承认本研究存在几个局限性，包括对光学影像的依赖，而光学影像容易受到热带地区持续云覆盖的影响。",
        targets: [
            { word: "acknowledge",  phonetic: "/əkˈnɒlɪdʒ/",    meaning: "承认; 认可",     collo: "acknowledge limitations" },
            { word: "susceptible",  phonetic: "/səˈseptɪbl/",    meaning: "易受影响的",     collo: "susceptible to" },
            { word: "persistent",   phonetic: "/pəˈsɪstənt/",   meaning: "持续的; 持久的", collo: "persistent problem" }
        ],
        options_pool: ["acknowledge", "susceptible", "persistent", "recognize", "vulnerable", "continuous", "admit", "prone", "ongoing"]
    }

];
