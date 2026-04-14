/**
 * Expression Coach Data — Native English Phrasing Patterns
 *
 * Categories:
 *   requesting   — Directing action, giving instructions
 *   suggesting   — Proposing ideas, recommending approaches
 *   evaluating   — Critiquing, giving feedback, assessing quality
 *   explaining   — Providing reasoning, contextualizing decisions
 *   scoping      — Consolidating, narrowing focus, setting boundaries
 *   workflow     — Directing multi-step processes, coordinating tasks
 *
 * Each entry supports three exercise types:
 *   fill-blank  — blanks[] array, answer is expr
 *   scenario    — options[] array, index 0 is always correct
 *   rephrase    — rephrase string is the "clumsy" prompt; expr is target
 *
 * To add a new expression: append to EXPRESSIONS array, assign next id.
 */

window.EXPRESSIONS = [

    // ═══════════════════════════════════════════════════════════════
    //  CATEGORY: requesting — Directing action, giving instructions
    // ═══════════════════════════════════════════════════════════════

    {
        id       : "req_01",
        cat      : "requesting",
        expr     : "clean it up and create a production version",
        chinese  : "整理干净并创建一个正式版本",
        pattern  : "clean X up and create a Y version",
        original : "Here's our current script with all the debugging code. Can you clean it up and create a production version that focuses on the key analyses we need?",
        general  : "We have a rough draft with lots of margin notes. Can you clean it up and create a final version for the client?",
        blanks   : [
            "Here's the messy prototype. Can you _____ and create a _____ that we can ship?",
        ],
        blankAnswers : ["clean it up", "production version"],
        options  : [
            "Can you clean it up and create a production version?",
            "Can you delete all the bad code and make it professional?",
            "Please remove the useless parts and finalize everything.",
            "Make the code good and ready for release."
        ],
        rephrase : "Please remove all the debug code and make a final clean version of the script that's ready to use."
    },

    {
        id       : "req_02",
        cat      : "requesting",
        expr     : "strip out anything irrelevant for now",
        chinese  : "暂时去掉所有无关的内容",
        pattern  : "strip out X for now",
        original : "Why don't we create a simple script just to verify the edge detection works first? We can strip out anything irrelevant for now.",
        general  : "Let's build a quick prototype to test the core idea. We can strip out anything irrelevant for now.",
        blanks   : [
            "Let's keep this simple — we can _____ anything _____ for now and focus on the main feature.",
        ],
        blankAnswers : ["strip out", "irrelevant"],
        options  : [
            "We can strip out anything irrelevant for now.",
            "We can delete all the things we don't need temporarily.",
            "Let's remove the unnecessary stuff for the moment.",
            "We should take away the parts that are not important now."
        ],
        rephrase : "Let's remove all the parts we don't need right now and just test the basic function first."
    },

    {
        id       : "req_03",
        cat      : "requesting",
        expr     : "Can you help me format these properly",
        chinese  : "你能帮我把这些格式整理好吗",
        pattern  : "help me + verb + properly/correctly",
        original : "Here are the results at 90m resolution. Can you help me format these properly and analyze what we found?",
        general  : "I've collected the survey responses. Can you help me format these properly so we can share them with the team?",
        blanks   : [
            "Here are the raw numbers from the experiment. Can you _____ these _____ for the report?",
        ],
        blankAnswers : ["help me format", "properly"],
        options  : [
            "Can you help me format these properly?",
            "Can you make these data look correct?",
            "Please arrange these numbers in a good way.",
            "Help me to organize these in the right format."
        ],
        rephrase : "I have the results but they look messy. Can you make them look nice and organized for the report?"
    },

    {
        id       : "req_04",
        cat      : "requesting",
        expr     : "Can you help me figure out what's wrong and how to fix it?",
        chinese  : "你能帮我找出问题所在并解决吗？",
        pattern  : "help me figure out what's wrong and how to fix it",
        original : "We're seeing many 1390 km distance values in the summary CSV, which doesn't seem realistic. Can you help me figure out what's wrong and how to fix it?",
        general  : "The monthly totals don't match the quarterly report. Can you help me figure out what's wrong and how to fix it?",
        blanks   : [
            "The output looks suspicious — some values are way off. Can you help me _____ what's _____ and how to _____ it?",
        ],
        blankAnswers : ["figure out", "wrong", "fix"],
        options  : [
            "Can you help me figure out what's wrong and how to fix it?",
            "Can you find the error and repair it for me?",
            "What is the problem and how to solve?",
            "Please check what mistake happened and correct it."
        ],
        rephrase : "Something is wrong with the distance values — they are too large to be real. Please help me find the reason and correct it."
    },

    {
        id       : "req_05",
        cat      : "requesting",
        expr     : "Please provide the complete, ready-to-run script that adds X",
        chinese  : "请提供完整的、可以直接运行的脚本，包含……",
        pattern  : "provide the complete, ready-to-run X that adds/includes Y",
        original : "Please provide the complete, ready-to-run script that adds the regression equation with r and exact p.",
        general  : "Please provide the complete, ready-to-run config file that includes all the API endpoints we discussed.",
        blanks   : [
            "Please _____ the _____, _____ script that includes the new chart formatting.",
        ],
        blankAnswers : ["provide", "complete", "ready-to-run"],
        options  : [
            "Please provide the complete, ready-to-run script.",
            "Please give me the full code that can work directly.",
            "Send me the finished script I can run without changes.",
            "Please write all the code so I can just execute it."
        ],
        rephrase : "I need the full script with everything included so I can run it directly without making any changes."
    },

    {
        id       : "req_06",
        cat      : "requesting",
        expr     : "with minimal printing",
        chinese  : "尽量少打印输出",
        pattern  : "with minimal X",
        original : "Can you create a simpler version that uses 30m resolution with minimal printing and just exports the results to Drive?",
        general  : "Can you rewrite this with minimal logging and just return the final result?",
        blanks   : [
            "Create a streamlined version _____ _____ and just export the final output.",
        ],
        blankAnswers : ["with minimal", "printing"],
        options  : [
            "A simpler version with minimal printing.",
            "A version that doesn't print so much.",
            "A version with less print statements.",
            "A version without too many outputs."
        ],
        rephrase : "Please make a version that doesn't have so many print statements — I only need the exported results."
    },

    {
        id       : "req_07",
        cat      : "requesting",
        expr     : "with all edits highlighted in bold",
        chinese  : "把所有修改的地方用粗体标出来",
        pattern  : "with all X highlighted/marked in Y",
        original : "Please show me the fully revised Introduction, with all edits highlighted in bold, and keep the existing references.",
        general  : "Send me the updated contract with all changes highlighted in yellow so the lawyer can review them.",
        blanks   : [
            "Please show the revised version, _____ all _____ highlighted _____ bold, so I can spot them quickly.",
        ],
        blankAnswers : ["with", "edits", "in"],
        options  : [
            "With all edits highlighted in bold so I can spot them quickly.",
            "Make the changed parts bold so I can see them.",
            "Bold all the places you edited for me to check.",
            "Use bold font to mark every modification."
        ],
        rephrase : "Show me the new version and use bold formatting to mark every sentence you changed so I can find them easily."
    },

    {
        id       : "req_08",
        cat      : "requesting",
        expr     : "refactor this to rely on our existing APIs as much as possible, and delete any that become redundant",
        chinese  : "重构代码，尽量使用现有的API，并删除冗余的部分",
        pattern  : "refactor X to rely on Y as much as possible, and delete any Z that become redundant",
        original : "I updated the project scripts. Please refactor this rubber-mapping workflow to rely on our existing module APIs as much as possible, and delete any helper functions that become redundant.",
        general  : "We just added shared utilities. Please refactor this service to rely on those as much as possible, and delete any local helpers that become redundant.",
        blanks   : [
            "Please _____ this workflow to _____ our existing module APIs _____, and delete any functions that become _____.",
        ],
        blankAnswers : ["refactor", "rely on", "as much as possible", "redundant"],
        options  : [
            "Refactor this to rely on our existing APIs as much as possible, and delete any that become redundant.",
            "Rewrite this to use our current APIs and remove the extra functions.",
            "Change the code to depend on existing APIs and clean up duplicates.",
            "Please modify to use existing APIs more and delete repeated functions."
        ],
        rephrase : "I want you to rewrite this code so it uses our shared module functions instead of its own helper functions, and remove any functions that are no longer needed."
    },

    {
        id       : "req_09",
        cat      : "requesting",
        expr     : "Please make this sound more natural by toning down any over-polished sentences",
        chinese  : "请让语言更自然，把过于雕琢的句子调整得平实些",
        pattern  : "make X sound more natural by toning down Y",
        original : "Please make this sound more natural in English by toning down any over-polished sentences and using fewer dashes and colons.",
        general  : "The press release sounds too corporate. Can you make it sound more natural by toning down the marketing jargon?",
        blanks   : [
            "Please make this _____ more natural by _____ down any _____ sentences.",
        ],
        blankAnswers : ["sound", "toning", "over-polished"],
        options  : [
            "Make it sound more natural by toning down any over-polished sentences.",
            "Make it less formal by reducing the too-perfect sentences.",
            "Please change the sentences that sound too artificial.",
            "Reduce the overly refined writing to be more normal."
        ],
        rephrase : "This writing sounds too perfect and formal — like a machine wrote it. Please rewrite it so it sounds more like a real person."
    },

    {
        id       : "req_10",
        cat      : "requesting",
        expr     : "I'll manually integrate your functions into my script and update the CONFIG myself",
        chinese  : "我会自己把你的函数整合到我的脚本里，CONFIG我自己来改",
        pattern  : "I'll manually X and Y myself",
        original : "Focus only on the forest edge analysis — ignore the other analyses. I'll manually integrate your functions into my script and update the CONFIG myself.",
        general  : "Just write the data processing functions. I'll manually integrate them into the main pipeline and handle the deployment myself.",
        blanks   : [
            "Just give me the utility functions. I'll _____ integrate them _____ my codebase and update the config _____.",
        ],
        blankAnswers : ["manually", "into", "myself"],
        options  : [
            "I'll manually integrate your functions into my script and update the CONFIG myself.",
            "I will put your functions into my code by myself and change the CONFIG.",
            "I can add your functions to my script and modify CONFIG on my own.",
            "Let me handle adding your code and updating the config personally."
        ],
        rephrase : "You don't need to worry about the full script. Just give me the functions and I will put them into my code and change the settings by myself."
    },

    // ═══════════════════════════════════════════════════════════════
    //  CATEGORY: suggesting — Proposing ideas, recommending approaches
    // ═══════════════════════════════════════════════════════════════

    {
        id       : "sug_01",
        cat      : "suggesting",
        expr     : "What if we merged the bands first and then called reduceRegion once?",
        chinese  : "如果我们先合并波段，然后只调用一次 reduceRegion 呢？",
        pattern  : "What if we X first and then Y?",
        original : "This function calls reduceRegion three times. What if we merged the bands first and then called reduceRegion once?",
        general  : "We're making three separate database queries. What if we combined the filters first and then ran one query?",
        blanks   : [
            "We're hitting the API three times. _____ we combined the requests _____ and then sent them _____?",
        ],
        blankAnswers : ["What if", "first", "once"],
        options  : [
            "What if we merged them first and then called it once?",
            "Why not merge them together first and then run it one time?",
            "Can we combine first and call only once?",
            "I suggest we merge first then do one call."
        ],
        rephrase : "I think we should combine everything together before processing, so we only need to call the function one time instead of three."
    },

    {
        id       : "sug_02",
        cat      : "suggesting",
        expr     : "Would this change significantly speed up the computation?",
        chinese  : "这个改动能显著加速计算吗？",
        pattern  : "Would this/that significantly speed up X?",
        original : "Would this change significantly speed up the computation?",
        general  : "We could cache the intermediate results. Would that significantly speed up the pipeline?",
        blanks   : [
            "If we switch to batch processing, _____ this _____ speed up the overall workflow?",
        ],
        blankAnswers : ["would", "significantly"],
        options  : [
            "Would this change significantly speed up the computation?",
            "Will this make the computation much faster?",
            "Can this change make the speed very fast?",
            "Does this optimization improve the processing speed a lot?"
        ],
        rephrase : "I want to know if making this change will make the computation much faster or if the improvement is small."
    },

    {
        id       : "sug_03",
        cat      : "suggesting",
        expr     : "I'd like to discuss how to determine the time intervals",
        chinese  : "我想先讨论一下如何确定时间区间",
        pattern  : "I'd like to discuss how to X",
        original : "Before analyzing the data, I'd like to discuss how to determine the time intervals. Based on the temporal changes, we have several options.",
        general  : "Before we start coding, I'd like to discuss how to structure the database schema.",
        blanks   : [
            "Before we dive into the analysis, _____ to discuss _____ to determine the best approach.",
        ],
        blankAnswers : ["I'd like", "how"],
        options  : [
            "I'd like to discuss how to determine the time intervals.",
            "I want to talk about how to decide the time intervals.",
            "Let's have a conversation about the time interval decision.",
            "We should discuss about how to choose time intervals."
        ],
        rephrase : "Before we start the analysis, I think we need to talk about what time intervals to use."
    },

    {
        id       : "sug_04",
        cat      : "suggesting",
        expr     : "Which would you recommend, and what's the reasoning behind that choice?",
        chinese  : "你推荐哪个方案？理由是什么？",
        pattern  : "Which would you recommend, and what's the reasoning behind X?",
        original : "We have several options: year-by-year, fixed intervals, or turning point-based intervals. Which would you recommend, and what's the reasoning behind that choice?",
        general  : "We could use PostgreSQL, MongoDB, or DynamoDB. Which would you recommend, and what's the reasoning behind that choice?",
        blanks   : [
            "There are three approaches we could take. _____ would you recommend, and what's the _____ behind that _____?",
        ],
        blankAnswers : ["Which", "reasoning", "choice"],
        options  : [
            "Which would you recommend, and what's the reasoning behind that choice?",
            "Which one do you think is best and why?",
            "What's your recommendation and the reason?",
            "Which do you suggest? Please explain the reason."
        ],
        rephrase : "We have three options. Which one do you think is the best, and can you explain the reason for your recommendation?"
    },

    {
        id       : "sug_05",
        cat      : "suggesting",
        expr     : "Before we revise, we should discuss whether we actually need four objectives",
        chinese  : "在修改之前，我们应该讨论一下是否真的需要四个目标",
        pattern  : "Before we X, we should discuss whether we actually need Y",
        original : "Before we revise, we should discuss whether we actually need 4 research objectives, or if we should consolidate them.",
        general  : "Before we start building, we should discuss whether we actually need all five microservices.",
        blanks   : [
            "_____ we revise, we should discuss _____ we actually _____ four separate sections.",
        ],
        blankAnswers : ["Before", "whether", "need"],
        options  : [
            "Before we revise, we should discuss whether we actually need four objectives.",
            "Let's think about if four objectives are really necessary before revising.",
            "We should consider whether four objectives is too many before we change.",
            "Before making changes, we need to decide if four objectives are required."
        ],
        rephrase : "I think we should first decide if having four research objectives is necessary. Maybe we should reduce them before we start editing."
    },

    {
        id       : "sug_06",
        cat      : "suggesting",
        expr     : "Should we limit the search to X only? Since Y papers are scarce, should we broaden it to Z too?",
        chinese  : "我们是否只搜索X？由于Y方面的论文很少，是否应该把范围扩大到Z？",
        pattern  : "Should we limit to X? Since Y is scarce, should we broaden to Z?",
        original : "Should we limit the search to rubber papers only? Since immature-rubber mapping papers are scarce, should we broaden it to early identification of other crops too?",
        general  : "Should we limit the literature review to deep learning papers only? Since applications in our domain are scarce, should we broaden it to related fields too?",
        blanks   : [
            "Should we _____ the search to rubber papers _____? Since relevant studies are _____, should we _____ it to related topics too?",
        ],
        blankAnswers : ["limit", "only", "scarce", "broaden"],
        options  : [
            "Since rubber papers are scarce, should we broaden it to other crops too?",
            "Because rubber papers are few, should we also include other crop papers?",
            "Rubber papers are not enough, so should we expand the search range?",
            "There are limited rubber papers — maybe we should search wider?"
        ],
        rephrase : "There are not many papers specifically about rubber. Do you think we should also search for papers about other crops to get more references?"
    },

    // ═══════════════════════════════════════════════════════════════
    //  CATEGORY: evaluating — Critiquing, giving feedback
    // ═══════════════════════════════════════════════════════════════

    {
        id       : "eval_01",
        cat      : "evaluating",
        expr     : "I've noticed there are still logic and repetition issues",
        chinese  : "我注意到仍然存在逻辑和重复的问题",
        pattern  : "I've noticed there are still X issues",
        original : "I've noticed there are still logic and repetition issues, especially within paragraphs. Here's the latest full version — please evaluate it first.",
        general  : "I've noticed there are still consistency issues across the slides. Can you do another pass?",
        blanks   : [
            "I've _____ there are _____ logic and repetition _____, especially in the middle section.",
        ],
        blankAnswers : ["noticed", "still", "issues"],
        options  : [
            "I've noticed there are still logic and repetition issues.",
            "I found there are still some logic problems and repeated content.",
            "I can see the logic and repetition errors still exist.",
            "There are still problems with logic and things are repeated."
        ],
        rephrase : "After reading the latest version, I found some problems — the logic is not clear in some places and some ideas are repeated."
    },

    {
        id       : "eval_02",
        cat      : "evaluating",
        expr     : "This paragraph doesn't flow smoothly from the previous one",
        chinese  : "这一段和前一段之间衔接不流畅",
        pattern  : "X doesn't flow smoothly from Y",
        original : "This paragraph doesn't flow smoothly from the previous one. 'These findings' — whose findings? Ours or other scholars'?",
        general  : "The second section doesn't flow smoothly from the introduction. The reader gets lost at the transition.",
        blanks   : [
            "This section _____ flow _____ from the one before it — the connection feels abrupt.",
        ],
        blankAnswers : ["doesn't", "smoothly"],
        options  : [
            "This paragraph doesn't flow smoothly from the previous one.",
            "This paragraph and the previous one are not well connected.",
            "The connection between this and the last paragraph is not smooth.",
            "This paragraph doesn't have a good transition from the previous."
        ],
        rephrase : "I feel the connection between this paragraph and the one before it is not natural. The reader might feel confused at this point."
    },

    {
        id       : "eval_03",
        cat      : "evaluating",
        expr     : "The transition is weak",
        chinese  : "过渡（衔接）很弱",
        pattern  : "The transition is weak/abrupt/missing",
        original : "You're right. The transition is weak. The previous paragraph ends with historical explanation, then suddenly jumps to a defensive statement.",
        general  : "I agree with your feedback. The transition is weak between the methodology and results sections.",
        blanks   : [
            "You're right. The _____ is _____. It jumps from one topic to another without connecting them.",
        ],
        blankAnswers : ["transition", "weak"],
        options  : [
            "The transition is weak — it jumps suddenly.",
            "The connection between them is not strong enough.",
            "The linking between paragraphs needs improvement.",
            "There is a poor bridge between the two sections."
        ],
        rephrase : "I agree — the connection between these two parts is too sudden. One paragraph talks about history and the next one suddenly starts defending our approach."
    },

    {
        id       : "eval_04",
        cat      : "evaluating",
        expr     : "Does this Introduction read logically and flow smoothly?",
        chinese  : "这个引言读起来逻辑通顺吗？衔接流畅吗？",
        pattern  : "Does X read logically and flow smoothly?",
        original : "Does this Introduction read logically and flow smoothly? If not, where do the transitions feel abrupt, and how can I improve them?",
        general  : "Does this proposal read logically and flow smoothly? I want to make sure the argument builds naturally.",
        blanks   : [
            "_____ this revised Introduction _____ logically and _____ smoothly? If not, where should I fix it?",
        ],
        blankAnswers : ["Does", "read", "flow"],
        options  : [
            "Does it read logically and flow smoothly?",
            "Is the logic clear and does it connect well?",
            "Can you check if the reading is logical and smooth?",
            "Is this section logical and the transitions natural?"
        ],
        rephrase : "I want to know if the Introduction has clear logic and if each paragraph connects naturally to the next one."
    },

    {
        id       : "eval_05",
        cat      : "evaluating",
        expr     : "feel unnatural or over-polished",
        chinese  : "感觉不自然或者过度修饰",
        pattern  : "feel unnatural / over-polished / AI-written",
        original : "Can you check whether my Introduction sounds 'AI-written,' and point out any places that feel unnatural or over-polished?",
        general  : "Read through this email and flag anything that feels unnatural or over-polished — I want it to sound like me.",
        blanks   : [
            "Please point out any sentences that _____ _____ or _____.",
        ],
        blankAnswers : ["feel", "unnatural", "over-polished"],
        options  : [
            "Point out any places that feel unnatural or over-polished.",
            "Show me the parts that sound weird or too perfect.",
            "Mark the sentences that don't feel like real writing.",
            "Find the parts that seem artificial or too formal."
        ],
        rephrase : "Some sentences in my writing sound too perfect, like they were written by AI. Please find those sentences and tell me which ones."
    },

    {
        id       : "eval_06",
        cat      : "evaluating",
        expr     : "That mismatch is the red flag you're worried about",
        chinese  : "那个不一致正是你担心的危险信号",
        pattern  : "X is the red flag you're worried about",
        original : "That mismatch is the red flag you're worried about.",
        general  : "The revenue numbers not matching the invoices — that's the red flag we should investigate.",
        blanks   : [
            "That _____ is the _____ _____ you're worried about — it suggests something is off.",
        ],
        blankAnswers : ["mismatch", "red", "flag"],
        options  : [
            "That mismatch is the red flag you're worried about.",
            "That inconsistency is the warning sign you are concerned with.",
            "This mismatch is the danger signal that worries you.",
            "That difference is the problem indicator you noticed."
        ],
        rephrase : "The inconsistency you noticed is exactly the warning sign that something might be wrong."
    },

    {
        id       : "eval_07",
        cat      : "evaluating",
        expr     : "check whether my Introduction sounds 'AI-written'",
        chinese  : "检查我的引言是否听起来像AI写的",
        pattern  : "check whether X sounds 'AI-written'",
        original : "Can you check whether my Introduction sounds 'AI-written,' and point out any places that feel unnatural or over-polished?",
        general  : "Before I submit, can you check whether this cover letter sounds AI-written? I want it to feel authentic.",
        blanks   : [
            "Can you _____ whether my paper _____ 'AI-written' and mark the suspicious parts?",
        ],
        blankAnswers : ["check", "sounds"],
        options  : [
            "Can you check whether it sounds 'AI-written'?",
            "Can you see if this seems like AI generated it?",
            "Does this look like it was written by AI?",
            "Can you judge if this paper was made by AI?"
        ],
        rephrase : "I'm worried my introduction was obviously written with help from AI. Can you read it and tell me which parts look like AI wrote them?"
    },

    // ═══════════════════════════════════════════════════════════════
    //  CATEGORY: explaining — Providing reasoning, contextualizing
    // ═══════════════════════════════════════════════════════════════

    {
        id       : "exp_01",
        cat      : "explaining",
        expr     : "That was just my initial impression",
        chinese  : "那只是我的初步印象",
        pattern  : "just my initial impression / gut feeling",
        original : "Regarding 2015, that was just my initial impression since PLC-TF drops sharply after that year. There's no other specific reason behind it.",
        general  : "I picked 2020 as the cutoff, but that was just my initial impression. Happy to adjust based on the data.",
        blanks   : [
            "I suggested that year, but it was _____ my _____ _____  — no rigorous analysis behind it.",
        ],
        blankAnswers : ["just", "initial", "impression"],
        options  : [
            "That was just my initial impression.",
            "That was only my first feeling about it.",
            "It was my preliminary opinion.",
            "That's what I first thought about it."
        ],
        rephrase : "I chose 2015 based on my rough feeling from looking at the graph, not based on any careful analysis."
    },

    {
        id       : "exp_02",
        cat      : "explaining",
        expr     : "There's no other specific reason behind it",
        chinese  : "没有其他特别的原因",
        pattern  : "no other specific reason behind it",
        original : "There's no other specific reason behind it.",
        general  : "We chose Python simply because the team knows it best. There's no other specific reason behind it.",
        blanks   : [
            "I picked that threshold from the chart trend. There's _____ other _____ reason _____ it.",
        ],
        blankAnswers : ["no", "specific", "behind"],
        options  : [
            "There's no other specific reason behind it.",
            "There isn't any other special reason for it.",
            "No other particular reason exists for this.",
            "I don't have any other reason for this choice."
        ],
        rephrase : "I don't have any special reason for choosing this. It was just based on what the chart looks like."
    },

    {
        id       : "exp_03",
        cat      : "explaining",
        expr     : "which I want to avoid",
        chinese  : "这是我想避免的",
        pattern  : "which I want to avoid",
        original : "When I use the account switcher, opening a new tab often defaults back to the first account, which I want to avoid.",
        general  : "Using a single shared database would create coupling between the services, which I want to avoid.",
        blanks   : [
            "Switching accounts in the same window keeps reverting to the first one, _____ I _____ to _____.",
        ],
        blankAnswers : ["which", "want", "avoid"],
        options  : [
            "...which I want to avoid.",
            "...and I don't want this to happen.",
            "...that's something I want to prevent.",
            "...this is what I don't wish to occur."
        ],
        rephrase : "The tab keeps going back to my first account. I don't want this behavior."
    },

    {
        id       : "exp_04",
        cat      : "explaining",
        expr     : "I noticed you set the sampling scale to 90m",
        chinese  : "我注意到你把采样尺度设成了90m",
        pattern  : "I noticed you + past tense (polite observation)",
        original : "I noticed you set the sampling scale to 90m for speed. Should we change it to 30m if it doesn't time out?",
        general  : "I noticed you used a simplified formula in the last commit. Was that intentional, or should we use the full version?",
        blanks   : [
            "_____ you _____ the timeout to 30 seconds. Should we increase it for the production environment?",
        ],
        blankAnswers : ["I noticed", "set"],
        options  : [
            "I noticed you set the sampling scale to 90m for speed.",
            "I see you put the sampling scale at 90m for faster processing.",
            "I found that you changed the sampling to 90m.",
            "I observed the sampling scale was configured to 90m by you."
        ],
        rephrase : "You used 90m for the sampling scale — I think you did this to make it faster. Do you think we should try 30m instead?"
    },

    {
        id       : "exp_05",
        cat      : "explaining",
        expr     : "as we discussed earlier",
        chinese  : "正如我们之前讨论的",
        pattern  : "as we discussed/mentioned earlier",
        original : "Yes, absolutely — this optimization provides significant speedup, similar to the reduceResolution case we discussed earlier.",
        general  : "We should use the caching strategy as we discussed earlier in the architecture review.",
        blanks   : [
            "This follows the same pattern _____ we _____ earlier in our first meeting.",
        ],
        blankAnswers : ["as", "discussed"],
        options  : [
            "...similar to what we discussed earlier.",
            "...like what we talked about before.",
            "...same as our previous discussion.",
            "...as per our earlier conversation."
        ],
        rephrase : "This is the same optimization approach that we talked about in our previous conversation."
    },

    // ═══════════════════════════════════════════════════════════════
    //  CATEGORY: scoping — Consolidating, narrowing focus
    // ═══════════════════════════════════════════════════════════════

    {
        id       : "sco_01",
        cat      : "scoping",
        expr     : "We need to consolidate the research gaps to avoid listing too many",
        chinese  : "我们需要整合研究空白，避免列举太多",
        pattern  : "consolidate X to avoid listing/having too many",
        original : "Yes, we need to consolidate the research gaps to avoid listing too many. But before merging them, we should confirm whether these gaps actually exist.",
        general  : "We need to consolidate the feature requests to avoid listing too many in the sprint backlog.",
        blanks   : [
            "We need to _____ the research gaps to _____ _____ too many in the introduction.",
        ],
        blankAnswers : ["consolidate", "avoid", "listing"],
        options  : [
            "We need to consolidate them to avoid listing too many.",
            "We should combine them so we don't have too many.",
            "We need to merge them to reduce the number.",
            "Let's group them together to decrease the total count."
        ],
        rephrase : "There are too many research gaps listed. We should combine some of them so the list isn't so long."
    },

    {
        id       : "sco_02",
        cat      : "scoping",
        expr     : "we should confirm whether these gaps actually exist and are worth studying",
        chinese  : "我们应该确认这些空白是否真实存在、是否值得研究",
        pattern  : "confirm whether X actually exist(s) and is/are worth Y",
        original : "Before merging them, we should confirm whether these gaps actually exist in the current literature and are worth studying, and whether our study actually addresses them.",
        general  : "Before adding these features, we should confirm whether the pain points actually exist and are worth solving.",
        blanks   : [
            "Before merging, we should _____ whether these gaps _____ exist and are _____ studying.",
        ],
        blankAnswers : ["confirm", "actually", "worth"],
        options  : [
            "We should confirm whether these gaps actually exist and are worth studying.",
            "We need to check if these problems are real and if they deserve research.",
            "We should verify the existence and research value of these gaps.",
            "Let's make sure these gaps are real and meaningful to investigate."
        ],
        rephrase : "Before we combine the research gaps, we should first check if they are real problems in the literature and if our paper actually solves them."
    },

    {
        id       : "sco_03",
        cat      : "scoping",
        expr     : "whether our study actually addresses them",
        chinese  : "我们的研究是否真的解决了这些问题",
        pattern  : "whether our X actually addresses Y",
        original : "...and whether our study actually addresses them.",
        general  : "We should also verify whether our proposed solution actually addresses the users' core complaints.",
        blanks   : [
            "We also need to check _____ our study _____ _____ these gaps.",
        ],
        blankAnswers : ["whether", "actually", "addresses"],
        options  : [
            "...and whether our study actually addresses them.",
            "...and if our paper really solves these problems.",
            "...and whether our research truly covers these issues.",
            "...and if our work actually responds to these gaps."
        ],
        rephrase : "We should also think about whether our paper really solves the problems we mentioned as research gaps."
    },

    {
        id       : "sco_04",
        cat      : "scoping",
        expr     : "prefer not wrapping unless a single line is extremely long",
        chinese  : "尽量不换行，除非单行特别长",
        pattern  : "prefer not X-ing unless Y",
        original : "I'd like rich docstrings with usage demos for the export APIs — prefer not wrapping docstring text unless a single line is extremely long.",
        general  : "Prefer not splitting the component into subfiles unless the file gets extremely large.",
        blanks   : [
            "I'd _____ not _____ the text _____ a single line is extremely long.",
        ],
        blankAnswers : ["prefer", "wrapping", "unless"],
        options  : [
            "Prefer not wrapping unless a single line is extremely long.",
            "Don't break lines if they are not very long.",
            "Try not to wrap the text except when lines are too long.",
            "I don't want line breaks unless absolutely necessary."
        ],
        rephrase : "Please keep each line on a single line. Only break the line if it becomes really long."
    },

    // ═══════════════════════════════════════════════════════════════
    //  CATEGORY: workflow — Directing multi-step processes
    // ═══════════════════════════════════════════════════════════════

    {
        id       : "wf_01",
        cat      : "workflow",
        expr     : "we'll proceed with the detailed revisions",
        chinese  : "我们将进行详细的修改",
        pattern  : "proceed with the detailed X",
        original : "I'd like you to conduct a comprehensive evaluation of their comments against our latest manuscript, then propose optimal revision suggestions. Once we reach agreement, we'll proceed with the detailed revisions.",
        general  : "Let's align on the architecture first. Once we agree, we'll proceed with the detailed implementation.",
        blanks   : [
            "Once we reach agreement on the plan, we'll _____ with the _____ revisions.",
        ],
        blankAnswers : ["proceed", "detailed"],
        options  : [
            "Once we agree, we'll proceed with the detailed revisions.",
            "After we agree, we will start doing the detailed changes.",
            "When we have consensus, we can begin the specific edits.",
            "After reaching agreement, we'll go ahead and make detailed modifications."
        ],
        rephrase : "After we agree on what to change, we will start making the detailed edits to the manuscript."
    },

    {
        id       : "wf_02",
        cat      : "workflow",
        expr     : "We should first review X, identify parts where reviewers might raise questions, and then propose revision suggestions",
        chinese  : "我们应该先审查X，找出审稿人可能质疑的地方，然后提出修改建议",
        pattern  : "first review X, identify where Y might raise questions, then propose Z",
        original : "Can you revise it to improve clarity? We should first review the current Methods section, identify parts where reviewers might raise questions, and then propose revision suggestions. If you need more input from us, just let us know.",
        general  : "We should first review the current API design, identify endpoints where users might have confusion, and then propose documentation improvements.",
        blanks   : [
            "We should _____ review the Methods, _____ parts where reviewers might _____ questions, and then _____ suggestions.",
        ],
        blankAnswers : ["first", "identify", "raise", "propose"],
        options  : [
            "First review, identify where reviewers might raise questions, then propose suggestions.",
            "Review first, find the problems reviewers would ask about, and suggest changes.",
            "Check the paper first, see what reviewers will question, then recommend edits.",
            "Start by reviewing, then find reviewer concerns, and give revision ideas."
        ],
        rephrase : "Let's read through the Methods section first. Then we find the places where reviewers will probably ask questions. After that, we suggest how to fix those parts."
    },

    {
        id       : "wf_03",
        cat      : "workflow",
        expr     : "craft a strong prompt to find supporting references and generate reports we can use for revisions",
        chinese  : "设计一个好的检索提示，找到支持性文献并生成可用于修改的报告",
        pattern  : "craft a strong X to find Y and generate Z we can use for W",
        original : "Let's repeat the same kind of manuscript-level critique on this new rubber phenology paper, then craft a strong Elicit prompt to find supporting references and generate reports we can use for revisions.",
        general  : "After the code review, let's craft a strong search query to find similar open-source solutions and generate a comparison we can use for the proposal.",
        blanks   : [
            "Let's _____ a strong prompt to _____ supporting references and _____ reports we can _____ for revisions.",
        ],
        blankAnswers : ["craft", "find", "generate", "use"],
        options  : [
            "Craft a strong prompt to find references and generate reports we can use.",
            "Make a good search query to find papers and create reports for our use.",
            "Design an effective prompt to search references and produce useful reports.",
            "Write a powerful prompt to locate references and build reports for revision."
        ],
        rephrase : "We need to write a good search query that will help us find relevant papers, and then create a summary report that we can reference when revising the manuscript."
    },

    {
        id       : "wf_04",
        cat      : "workflow",
        expr     : "Let's discuss the outline first, then do the detailed drafting",
        chinese  : "我们先讨论大纲，再做详细撰写",
        pattern  : "discuss X first, then do the detailed Y",
        original : "Let me share our paper and a draft Methods section for your reference. Let's discuss the outline first, then do the detailed drafting.",
        general  : "Here's the current sitemap. Let's discuss the structure first, then do the detailed wireframes.",
        blanks   : [
            "Let's _____ the outline _____, then do the _____ drafting.",
        ],
        blankAnswers : ["discuss", "first", "detailed"],
        options  : [
            "Let's discuss the outline first, then do the detailed drafting.",
            "We should talk about the structure first, then write the details.",
            "First let's agree on the outline, after that we can write it in detail.",
            "Discuss the plan first, then work on the detailed writing."
        ],
        rephrase : "I want to agree on the overall structure before we start writing the full text."
    },

];

// ─── Category metadata for UI display ───────────────────────────
window.EXPR_CATEGORIES = {
    requesting : { label: "Requesting Action",     icon: "🎯", color: "#4A90D9" },
    suggesting : { label: "Suggesting / Proposing", icon: "💡", color: "#7B68EE" },
    evaluating : { label: "Evaluating / Critiquing", icon: "🔍", color: "#E67E22" },
    explaining : { label: "Explaining Reasoning",   icon: "💬", color: "#27AE60" },
    scoping    : { label: "Scoping / Consolidating", icon: "🎛️", color: "#E74C3C" },
    workflow   : { label: "Directing Workflow",      icon: "📋", color: "#8E44AD" },
};
