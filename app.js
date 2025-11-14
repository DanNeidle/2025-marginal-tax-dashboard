/*
(c) Tax Policy Associates Ltd, 2025, licensed under the MIT licence.
Permission is hereby granted, free of charge, to any person obtaining a copy of this software,
to use it however they wish provided they attribute it to Tax Policy Associates Ltd.
*/
const { createApp } = Vue;

const STUDENT_LOAN_COMPONENTS = {
    plan1: { rate: 0.09, threshold: 26065 },
    plan2: { rate: 0.09, threshold: 28470 },
    plan4: { rate: 0.09, threshold: 32745 },
    plan5: { rate: 0.09, threshold: 25000 },
    plan3: { rate: 0.06, threshold: 21000 }
};

function buildStudentLoanPlan(id, label, componentKeys) {
    return {
        id,
        label,
        components: componentKeys.map(key => ({ ...STUDENT_LOAN_COMPONENTS[key] }))
    };
}

createApp({
    // =====================
    //  Data Properties
    // =====================
    data() {
        return {
            // --- Modelling Constants ---
            BASE_MAX_INCOME: 180000,
            MAX_INCOME: 180000,
            AXIS_EXTENSION_THRESHOLD: 170000,
            AXIS_EXTENSION_STEP: 100000,
            PERTURBATION: 100,
            CHART_COLOURS: ['#1133AF', '#FF5733'],

            // --- UI Bound State ---
            selectedDataset: "2025-26 UK",
            chartType: 'Marginal rate',
            employmentType: 'Employed',
            children: 0,
            childcareSubsidyAmount: 0,
            includeStudentLoan: false,
            includeMarriageAllowance: false,
            selectedStudentLoanPlan: 'plan2',
            compareDataset: "None",
            customIncomeInput: null,
            displayedIncome: null,
            summaryResults: {
                afterTaxIncome: "-",
                totalTax: "-",
                effectiveRate: "-",
                marginalRate: "-"
            },
            detailResults: {
                incomeTaxBands: [],
                incomeTaxTotal: "-",
                niBands: [],
                niTotal: "-",
                personalAllowance: 0,
                adjustments: [],
                adjustmentsTotal: "-"
            },
            latestPrimarySummary: null,
            comparisonResults: null,
            studentLoanPlans: [
                buildStudentLoanPlan('plan1', 'Plan 1 (before Sept 2012)', ['plan1']),
                buildStudentLoanPlan('plan2', 'Plan 2 (Sept 2012 to July 2023)', ['plan2']),
                buildStudentLoanPlan('plan4', 'Plan 4 (Scotland)', ['plan4']),
                buildStudentLoanPlan('plan5', 'Plan 5 (after August 2023)', ['plan5']),
                buildStudentLoanPlan('plan3', 'Plan 3 (postgraduate loan only)', ['plan3']),
                buildStudentLoanPlan('plan1_pg', 'Plan 1 + postgraduate loan', ['plan1', 'plan3']),
                buildStudentLoanPlan('plan2_pg', 'Plan 2 + postgraduate loan', ['plan2', 'plan3']),
                buildStudentLoanPlan('plan4_pg', 'Plan 4 + postgraduate loan', ['plan4', 'plan3']),
                buildStudentLoanPlan('plan5_pg', 'Plan 5 + postgraduate loan', ['plan5', 'plan3'])
            ],

            // --- Tax Data (copied from JSON) ---
            taxData: {} // Will be loaded from tax_data.js
        };
    },

    // =====================
    //  Computed Properties
    // =====================
    computed: {
        datasetOptions() {
            return Object.keys(this.taxData || {}).sort((a, b) => b.localeCompare(a));
        },
        compareOptions() {
            const options = Object.keys(this.taxData || {}).sort((a, b) => b.localeCompare(a));
            return ["None", ...options];
        },
        childcareOptions() {
            if (!this.taxData[this.selectedDataset]) return [0];

            const max_subsidy = this.taxData[this.selectedDataset]["childcare subsidy per child"] || 0;
            if (max_subsidy === 0) return [0];

            const presetOptions = [0, 1000, 2000, 3000, 5000, 7500, 10000];
            const filtered = presetOptions.filter(amount => amount <= max_subsidy);
            return filtered.length ? filtered : [0];
        },
        employmentTerm() {
            const labels = {
                'Employed': 'employment',
                'Self-employed': 'self-employment',
                'Partnership/LLP': 'partnership/LLP',
                'Retired/State pension age': 'retirement',
                'Within IR35': 'IR35 contract'
            };
            return labels[this.employmentType] || 'employment';
        },
        employmentIncomeCopy() {
            const copies = {
                'Employed': { label: 'Your gross income', note: 'gross income' },
                'Self-employed': { label: 'Self-employment profits', note: 'self-employment profits' },
                'Partnership/LLP': { label: 'Partnership/LLP profits', note: 'partnership/LLP profits' },
                'Retired/State pension age': { label: 'Retirement income', note: 'retirement income' },
                'Within IR35': { label: 'Contract income (within IR35)', note: 'contract income (IR35)' }
            };
            return copies[this.employmentType] || copies['Employed'];
        },
        incomeInputLabel() {
            return `${this.employmentIncomeCopy.label} (£)`;
        },
        incomeNoteDescriptor() {
            return this.employmentIncomeCopy.note;
        }
    },

    // =====================
    //  Watchers
    // =====================
    watch: {
        selectedDataset() { this.updateResultsFromState(); this.updateChart(); },
        chartType() { this.updateChart(); },
        employmentType() {
            this.runWithoutScrollJump(() => {
                this.updateResultsFromState();
                this.updateChart();
            });
        },
        includeStudentLoan() { this.updateResultsFromState(); this.updateChart(); },
        includeMarriageAllowance() { this.updateResultsFromState(); this.updateChart(); },
        selectedStudentLoanPlan(newValue, oldValue) {
            if (this.includeStudentLoan && newValue !== oldValue) {
                this.updateResultsFromState();
                this.updateChart();
            }
        },
        compareDataset() { this.updateResultsFromState(); this.updateChart(); },
        children(newValue, oldValue) {
            if (newValue === 0 && this.childcareSubsidyAmount !== 0) {
                this.childcareSubsidyAmount = 0;
            }
            this.updateResultsFromState();
            this.updateChart();
        },
        childcareSubsidyAmount(newValue, oldValue) {
            if (newValue > 0 && this.children === 0) {
                this.children = 1;
                return;
            }
            this.updateResultsFromState();
            this.updateChart();
        }
    },

    // =====================
    //  Methods
    // =====================
    methods: {
        /**
         * Main tax calculation function, translated from Python.
         */
        calculateTaxAndNi(grossIncome, rulesetName, taxType, collectDetails = false, calculationMode = 'chart', overrides = {}) {
            const relevantData = this.taxData[rulesetName];
            if (!relevantData || !taxType) {
                if (!collectDetails) {
                    return 0;
                }
                return {
                    total: 0,
                    bands: [],
                    adjustments: [],
                    personalAllowance: null
                };
            }

            let totalTax = 0;
            let taxableNetIncome;
            const bandBreakdown = [];
            const adjustments = [];
            let personalAllowanceUsed = null;
            const isIncomeTax = taxType === "income tax";
            const bandRules = Array.isArray(relevantData[taxType]) ? relevantData[taxType] : [];
            const niClassLabel = isIncomeTax ? null : this.getNiClassLabel(taxType);
            const activeStudentLoanPlan = this.getActiveStudentLoanPlan();

            if (isIncomeTax) {
                // --- Personal Allowance ---
                let modifiedPersonalAllowance;
                if (overrides.forcePersonalAllowance !== undefined) {
                    modifiedPersonalAllowance = overrides.forcePersonalAllowance;
                } else {
                    modifiedPersonalAllowance = this.calculatePersonalAllowance(grossIncome, relevantData, calculationMode);
                }
                personalAllowanceUsed = modifiedPersonalAllowance;

                taxableNetIncome = Math.max(0, grossIncome - modifiedPersonalAllowance);

                // --- HICBC (High Income Child Benefit Charge) ---
                if (this.children > 0) {
                    const hicbc = this.calculateHICBCCharge(grossIncome, relevantData, calculationMode);
                    totalTax += hicbc;
                    if (collectDetails && hicbc > 0) {
                        adjustments.push({ label: "Child benefit clawback", amount: -hicbc, type: "debit" });
                    }
                }

                // --- Student Loan ---
                if (activeStudentLoanPlan) {
                    const loanCharge = (activeStudentLoanPlan.components || []).reduce((sum, component) => {
                        if (grossIncome > component.threshold) {
                            return sum + (grossIncome - component.threshold) * component.rate;
                        }
                        return sum;
                    }, 0);
                    if (loanCharge > 0) {
                        totalTax += loanCharge;
                        if (collectDetails) {
                            adjustments.push({ label: "Student loan", amount: loanCharge, type: "debit" });
                        }
                    }
                }

                // --- Marriage Allowance (as tax credit) ---
                if (this.includeMarriageAllowance && grossIncome < relevantData["marriage allowance max earnings"] && grossIncome > relevantData["statutory personal allowance"]) {
                    const transferredAllowance = relevantData["statutory personal allowance"] * relevantData["marriage allowance"];
                    const taxCredit = transferredAllowance * 0.20; // Basic rate credit
                    totalTax -= taxCredit;
                    if (collectDetails) {
                        adjustments.push({ label: "Marriage allowance credit", amount: -taxCredit, type: "credit" });
                    }
                }

            } else {
                taxableNetIncome = grossIncome;
            }

            // --- Calculate Tax on Bands ---
            let lastThreshold = 0;
            for (const band of bandRules) {
                const threshold = band.threshold || 1e12; // Use a large number for the final band
                if (taxableNetIncome > lastThreshold) {
                    const incomeInBand = Math.min(taxableNetIncome, threshold) - lastThreshold;
                    const taxInBand = incomeInBand * band.rate;
                    totalTax += taxInBand;
                    if (collectDetails) {
                        let label;
                        if (band.name) {
                            label = this.titleCase(band.name);
                            if (!isIncomeTax && niClassLabel) {
                                label = `${niClassLabel} - ${label}`;
                            }
                        } else {
                            label = isIncomeTax ? "Income Tax band" : `${niClassLabel || 'NI'} band`;
                        }
                        bandBreakdown.push({ label, amount: taxInBand });
                    }
                }
                lastThreshold = threshold;
            }

            if (!isIncomeTax && taxType === "NI class 4 (self-employed)") {
                const class2Contribution = this.calculateClass2Contribution(grossIncome, relevantData["NI class 2 (self-employed)"]);
                if (class2Contribution > 0) {
                    totalTax += class2Contribution;
                    if (collectDetails) {
                        const label = `${this.getNiClassLabel("NI class 2 (self-employed)")} - Flat rate`;
                        bandBreakdown.push({ label, amount: class2Contribution });
                    }
                }
            }

            if (!collectDetails) {
                return totalTax;
            }

            return {
                total: totalTax,
                bands: bandBreakdown,
                adjustments,
                personalAllowance: personalAllowanceUsed
            };
        },

        /**
         * Generates the data points for the chart for a given set of rules.
         */
        calculateTaxResultsForRuleset(ruleset) {
            const grossIncomes = Array.from({ length: (this.MAX_INCOME / this.PERTURBATION) + 1 }, (_, i) => i * this.PERTURBATION);
            const relevantData = this.taxData[ruleset];
            if (!relevantData) {
                return {
                    gross: [],
                    net: [],
                    marginal: [],
                    effective: []
                };
            }
            const childBenefitCredit = this.getChildBenefitAmount(relevantData);
            const niTaxKey = this.getActiveNiKey();

            const results = {
                gross: [],
                net: [],
                marginal: [],
                effective: []
            };

            let previousAdjustedTotalTax = 0;
            for (const grossIncome of grossIncomes) {
                const { taxableIncome, employerNi } = this.transformIncomeForEmployment(grossIncome, relevantData);
                const incomeTax = this.calculateTaxAndNi(taxableIncome, ruleset, "income tax");
                const nationalInsurance = this.calculateTaxAndNi(taxableIncome, ruleset, niTaxKey);
                const totalTaxNi = incomeTax + nationalInsurance + employerNi;
                const childcareCredit = this.calculateChildcareSubsidy(grossIncome, relevantData, taxableIncome);
                const adjustedTotalTax = totalTaxNi - childBenefitCredit - childcareCredit;
                const netIncome = grossIncome - adjustedTotalTax;

                const marginalRate = grossIncome === 0 ? 0 : ((adjustedTotalTax - previousAdjustedTotalTax) / this.PERTURBATION * 100);
                const effectiveRate = grossIncome === 0 ? 0 : ((adjustedTotalTax / grossIncome) * 100);

                results.gross.push(grossIncome);
                results.net.push(netIncome);
                results.marginal.push(marginalRate);
                results.effective.push(effectiveRate);

                previousAdjustedTotalTax = adjustedTotalTax;
            }
            return results;
        },

        titleCase(input) {
            if (!input) return '';
            return input.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
        },

        formatCurrency(value) {
            return `£${Math.round(value).toLocaleString('en-GB')}`;
        },

        getChildBenefitAmount(relevantData) {
            if (!relevantData || this.children === 0) {
                return 0;
            }
            return 52 * (relevantData["child benefit"]["1st"] + relevantData["child benefit"]["subsequent"] * (this.children - 1));
        },
        calculateChildcareSubsidy(grossIncome, relevantData, taxableIncomeOverride = null) {
            if (!relevantData || this.childcareSubsidyAmount <= 0 || this.children <= 0) {
                return 0;
            }
            const maxChildren = Number(relevantData["childcare max children"]) || 0;
            const eligibleChildren = Math.min(this.children, maxChildren || this.children);
            if (eligibleChildren <= 0) {
                return 0;
            }
            const potentialSubsidy = this.childcareSubsidyAmount * eligibleChildren;
            if (potentialSubsidy <= 0) {
                return 0;
            }
            const hasOverride = typeof taxableIncomeOverride === 'number' && Number.isFinite(taxableIncomeOverride);
            const eligibilityIncome = hasOverride ? taxableIncomeOverride : grossIncome;
            const minEarnings = Number(relevantData["childcare min earnings"]);
            if (Number.isFinite(minEarnings) && eligibilityIncome <= minEarnings) {
                return 0;
            }
            const maxEarnings = Number(relevantData["childcare max earnings"]);
            if (Number.isFinite(maxEarnings) && eligibilityIncome >= maxEarnings) {
                return 0;
            }
            return potentialSubsidy;
        },

        getEmployerNiConfig(dataset) {
            if (!dataset) {
                return null;
            }
            const config = dataset["employer NI"] ?? dataset["employer_NI"];
            if (config && typeof config === 'object') {
                return config;
            }
            const fallback = {};
            const partnershipRate = dataset["partnership employer nic rate"] ?? dataset["partnership_employer_nic_rate"];
            if (partnershipRate !== undefined) {
                fallback["partnership employer nic rate"] = partnershipRate;
            }
            const employerRate = dataset["employer nic rate"] ?? dataset["employer_nic_rate"];
            if (employerRate !== undefined) {
                fallback["employer nic rate"] = employerRate;
            }
            const threshold = dataset["employer nic secondary threshold"] ?? dataset["employer_nic_secondary_threshold"];
            if (threshold !== undefined) {
                fallback["employer nic secondary threshold"] = threshold;
            }
            return Object.keys(fallback).length > 0 ? fallback : null;
        },
        getEmployerNiRate(dataset) {
            if (!dataset || !this.employmentRequiresEmployerNiGrossDown()) {
                return 0;
            }
            const config = this.getEmployerNiConfig(dataset);
            if (!config) {
                return 0;
            }
            let rawRate = null;
            if (this.employmentType === 'Partnership/LLP') {
                rawRate = config["partnership employer nic rate"] ?? config["partnership_employer_nic_rate"];
            } else if (this.employmentType === 'Within IR35') {
                rawRate = config["employer nic rate"] ?? config["employer_nic_rate"];
            }
            const rate = Number(rawRate);
            return Number.isFinite(rate) && rate > 0 ? rate : 0;
        },
        getEmployerSecondaryThreshold(dataset) {
            if (!dataset || !this.employmentRequiresEmployerNiGrossDown()) {
                return 0;
            }
            const config = this.getEmployerNiConfig(dataset);
            if (!config) {
                return 0;
            }
            const weeklyThreshold = Number(config["employer nic secondary threshold"] ?? config["employer_nic_secondary_threshold"]);
            if (!Number.isFinite(weeklyThreshold) || weeklyThreshold <= 0) {
                return 0;
            }
            return weeklyThreshold * 52;
        },

        transformIncomeForEmployment(grossIncome, dataset) {
            let originalIncome = Number(grossIncome);
            if (!Number.isFinite(originalIncome) || originalIncome < 0) {
                originalIncome = 0;
            }
            const employerRate = this.getEmployerNiRate(dataset);
            if (employerRate <= 0) {
                return { taxableIncome: originalIncome, employerNi: 0 };
            }
            const annualSecondaryThreshold = this.getEmployerSecondaryThreshold(dataset);
            if (annualSecondaryThreshold <= 0) {
                const taxableIncome = originalIncome / (1 + employerRate);
                const employerNi = originalIncome - taxableIncome;
                return { taxableIncome, employerNi };
            }
            if (originalIncome <= annualSecondaryThreshold) {
                return { taxableIncome: originalIncome, employerNi: 0 };
            }
            const taxableIncome = (originalIncome + employerRate * annualSecondaryThreshold) / (1 + employerRate);
            const employerNi = Math.max(0, originalIncome - taxableIncome);
            return { taxableIncome, employerNi };
        },

        isSelfEmploymentType() {
            return this.employmentType === 'Self-employed' || this.employmentType === 'Partnership/LLP';
        },
        employmentRequiresEmployerNiGrossDown() {
            return this.employmentType === 'Partnership/LLP' || this.employmentType === 'Within IR35';
        },

        getActiveStudentLoanPlan() {
            if (!this.includeStudentLoan) {
                return null;
            }
            return this.studentLoanPlans.find(plan => plan.id === this.selectedStudentLoanPlan) || null;
        },

        getActiveNiKey() {
            if (this.employmentType === 'Retired/State pension age') {
                return null;
            }
            return this.isSelfEmploymentType() ? "NI class 4 (self-employed)" : "NI class 1 (employees)";
        },

        getNiClassLabel(taxType) {
            const labels = {
                "NI class 1 (employees)": "NI Class 1",
                "NI class 2 (self-employed)": "NI Class 2",
                "NI class 4 (self-employed)": "NI Class 4"
            };
            return labels[taxType] || "NI";
        },

        calculateClass2Contribution(grossIncome, class2Rules) {
            if (!class2Rules) {
                return 0;
            }
            const weeklyAmount = class2Rules["weekly amount"] ?? class2Rules["weekly_amount"];
            const lowerLimit = class2Rules["lower profits limit"] ?? class2Rules["lower_profits_limit"] ?? class2Rules["small_profits_threshold"] ?? 0;
            if (!weeklyAmount || grossIncome <= lowerLimit) {
                return 0;
            }
            return 52 * weeklyAmount;
        },

        calculatePersonalAllowance(grossIncome, relevantData, mode, baseAllowance) {
            let allowance = baseAllowance ?? relevantData["statutory personal allowance"];
            const threshold = relevantData["allowance withdrawal threshold"];
            const withdrawalRate = relevantData["allowance withdrawal rate"];

            if (grossIncome <= threshold || !withdrawalRate) {
                return allowance;
            }

            if (mode === 'actual') {
                let poundsPerReduction = withdrawalRate;
                if (poundsPerReduction < 1) {
                    poundsPerReduction = 1 / poundsPerReduction;
                }
                const steps = Math.floor((grossIncome - threshold) / poundsPerReduction);
                allowance = Math.max(0, allowance - steps);
            } else {
                let reductionPerPound = withdrawalRate;
                if (withdrawalRate >= 1) {
                    reductionPerPound = 1 / withdrawalRate;
                }
                const reduction = (grossIncome - threshold) * reductionPerPound;
                allowance = Math.max(0, allowance - reduction);
            }

            return allowance;
        },

        formatPercent(value) {
            if (value === "-" || value === null || Number.isNaN(value)) {
                return "-";
            }
            return `${value.toFixed(1)}%`;
        },

        shouldExtendAxisForIncome(income) {
            return typeof income === 'number' &&
                !Number.isNaN(income) &&
                income > this.AXIS_EXTENSION_THRESHOLD;
        },

        computeExtendedAxisCeiling(income) {
            const step = this.AXIS_EXTENSION_STEP;
            if (!step) return this.BASE_MAX_INCOME;
            const safeIncome = Math.max(0, income || 0);
            const multiplier = Math.floor(safeIncome / step) + 1;
            return multiplier * step;
        },

        updateMaxIncomeForValue(income) {
            const targetMax = this.shouldExtendAxisForIncome(income)
                ? this.computeExtendedAxisCeiling(income)
                : this.BASE_MAX_INCOME;
            if (targetMax !== this.MAX_INCOME) {
                this.MAX_INCOME = targetMax;
                return true;
            }
            return false;
        },

        resetChartMaxIncome() {
            if (this.MAX_INCOME !== this.BASE_MAX_INCOME) {
                this.MAX_INCOME = this.BASE_MAX_INCOME;
            }
        },

        updateResultsFromState() {
            if (this.displayedIncome === null) {
                return;
            }
            this.computeResultsForIncome(this.displayedIncome, false);
        },

        calculateHICBCCharge(grossIncome, relevantData, mode) {
            if (this.children === 0) return 0;

            const totalChildBenefit = 52 * (relevantData["child benefit"]["1st"] + relevantData["child benefit"]["subsequent"] * (this.children - 1));
            const hicbcStart = relevantData["HICBC start"] || 0;
            let incomePerPercent = relevantData["HICBC income per percent reduction"];
            let hicbcEnd = relevantData["HICBC end"];

            if (!incomePerPercent && hicbcEnd) {
                incomePerPercent = (hicbcEnd - hicbcStart) / 100;
            }
            if (!incomePerPercent || incomePerPercent <= 0) {
                incomePerPercent = 100;
            }

            if (!hicbcEnd) {
                hicbcEnd = hicbcStart + incomePerPercent * 100;
            }

            if (grossIncome <= hicbcStart) {
                return 0;
            }

            if (mode === 'actual') {
                const steps = Math.floor((grossIncome - hicbcStart) / incomePerPercent) + 1;
                const percentRepay = Math.min(steps, 100);
                return totalChildBenefit * (percentRepay / 100);
            }

            const fraction = Math.min(1, Math.max(0, (grossIncome - hicbcStart) / Math.max(hicbcEnd - hicbcStart, incomePerPercent)));
            return totalChildBenefit * fraction;
        },

        getChartSettings() {
            const employmentTerm = this.employmentTerm;
            const xAxisTitle = `Gross ${employmentTerm} income`;

            if (this.chartType === 'Marginal rate') {
                const yAxisTitle = 'Marginal tax rate';
                return {
                    yKey: 'marginal',
                    hoverTemplate: '%{y:.1f}%',
                    layout: {
                        title: `Gross ${employmentTerm} income vs marginal tax rate`,
                        xaxis: { title: xAxisTitle, tickprefix: '£' },
                        yaxis: { title: yAxisTitle, range: [0, 90], ticksuffix: '%' }
                    },
                    xAxisTitle,
                    yAxisTitle
                };
            }

            if (this.chartType === 'Effective rate') {
                const yAxisTitle = 'Effective tax rate';
                return {
                    yKey: 'effective',
                    hoverTemplate: '%{y:.1f}%',
                    layout: {
                        title: `Gross ${employmentTerm} income vs effective tax rate`,
                        xaxis: { title: xAxisTitle, tickprefix: '£' },
                        yaxis: { title: yAxisTitle, range: [0, 90], ticksuffix: '%' }
                    },
                    xAxisTitle,
                    yAxisTitle
                };
            }

            const yAxisTitle = 'Net income';
            return {
                yKey: 'net',
                hoverTemplate: '£%{y:,.0f}',
                layout: {
                    title: `Net ${employmentTerm} income vs gross income`,
                    xaxis: { title: xAxisTitle, tickprefix: '£' },
                    yaxis: { title: yAxisTitle, tickprefix: '£' }
                },
                xAxisTitle,
                yAxisTitle
            };
        },

        getMaxMarginalRate(results) {
            if (!results || !Array.isArray(results.marginal)) {
                return 0;
            }
            return results.marginal.reduce((max, value) => {
                return Number.isFinite(value) ? Math.max(max, value) : max;
            }, 0);
        },

        getMarginalAxisCeiling(baseResults, compareResults) {
            const highestRate = Math.max(
                this.getMaxMarginalRate(baseResults),
                this.getMaxMarginalRate(compareResults)
            );
            if (highestRate > 90 && highestRate <= 200) {
                return Math.min(200, Math.ceil(highestRate / 10) * 10);
            }
            return 90;
        },

        /**
         * Main function to redraw the Plotly chart.
         */
        updateChart() {
            if (!this.taxData[this.selectedDataset]) {
                return;
            }

            const baseResults = this.calculateTaxResultsForRuleset(this.selectedDataset);

            const compareActive = this.compareDataset && this.compareDataset !== "None" && this.taxData[this.compareDataset];
            const compareResults = compareActive ? this.calculateTaxResultsForRuleset(this.compareDataset) : null;

            const { yKey, layout, hoverTemplate } = this.getChartSettings();
            const isMobileViewport = window.matchMedia ? window.matchMedia('(max-width: 768px)').matches : false;
            const mobileDashPattern = '6px,6px';
            let marginalAxisRange = null;

            if (this.chartType === 'Marginal rate') {
                const axisCeiling = this.getMarginalAxisCeiling(baseResults, compareResults);
                marginalAxisRange = [0, axisCeiling];
            }

            const traces = [
                this.buildTrace(baseResults, this.selectedDataset, yKey, {
                    color: this.CHART_COLOURS[0],
                    dash: 'solid',
                    hoverTemplate
                })
            ];

            if (compareResults) {
                traces.push(
                    this.buildTrace(compareResults, this.compareDataset, yKey, {
                        color: '#D7263D',
                        dash: isMobileViewport ? mobileDashPattern : 'dash',
                        hoverTemplate
                    })
                );
            }

            const highlightIncome = this.displayedIncome;
            if (highlightIncome !== null && highlightIncome !== undefined) {
                const highlightSummary = this.getSummaryForIncome(this.selectedDataset, highlightIncome);
                const highlightValue = this.getChartValueForSummary(highlightSummary, this.chartType);
                if (highlightSummary && highlightValue !== null) {
                    const clampedIncome = Math.max(0, Math.min(highlightIncome, this.MAX_INCOME));
                    traces.push({
                        x: [clampedIncome],
                        y: [highlightValue],
                        mode: 'markers',
                        name: 'Your income',
                        marker: {
                            color: '#FF5733',
                            size: 14,
                            symbol: 'circle-open',
                            line: { color: '#FF5733', width: 3 }
                        },
                        showlegend: false,
                        hovertemplate: `Income ${this.formatCurrency(clampedIncome)}<br>${this.getChartLabel(this.chartType)}: ${this.formatChartValue(highlightValue, this.chartType)}<extra></extra>`
                    });
                }
            }

            const shouldShowLegend = !isMobileViewport && Boolean(compareResults);

            const commonLayout = {
                margin: { t: 50, l: 60, r: 20, b: 50 },
                hovermode: 'x unified',
                font: { family: 'Poppins, sans-serif' },
                showlegend: shouldShowLegend,
                legend: {
                    x: 0.1,
                    y: 0.9,
                    xanchor: 'left',
                    yanchor: 'top',
                    bgcolor: 'rgba(255,255,255,0.8)',
                    bordercolor: '#ccc',
                    borderwidth: 1
                }
            };

            const mergedLayout = { ...layout, ...commonLayout };
            mergedLayout.dragmode = false;
            mergedLayout.xaxis = { ...(layout.xaxis || {}), fixedrange: true };
            mergedLayout.yaxis = { ...(layout.yaxis || {}), fixedrange: true };
            if (marginalAxisRange) {
                mergedLayout.yaxis.range = marginalAxisRange;
            }

            Plotly.newPlot(
                'plotly-chart',
                traces,
                mergedLayout,
                {
                    responsive: true,
                    displayModeBar: false,
                    scrollZoom: false,
                    doubleClick: false
                }
            );
            this.resizeChart(); // Resize chart after drawing

        },

        downloadChartData() {
            if (!this.taxData[this.selectedDataset]) {
                return;
            }

            const chartSettings = this.getChartSettings();
            const results = this.calculateTaxResultsForRuleset(this.selectedDataset);
            const ySeries = results[chartSettings.yKey];
            const compareActive = this.compareDataset && this.compareDataset !== "None" && this.taxData[this.compareDataset];
            const compareResults = compareActive ? this.calculateTaxResultsForRuleset(this.compareDataset) : null;
            const compareSeries = compareResults ? compareResults[chartSettings.yKey] : null;

            if (!Array.isArray(results.gross) || !Array.isArray(ySeries)) {
                return;
            }

            const xHeading = this.slugifyLabel(chartSettings.xAxisTitle);
            const baseHeading = this.slugifyLabel(`${this.selectedDataset} - ${chartSettings.yAxisTitle}`);
            const headers = [xHeading, baseHeading];

            if (compareSeries && Array.isArray(compareSeries)) {
                const compareHeading = this.slugifyLabel(`${this.compareDataset} - ${chartSettings.yAxisTitle}`);
                headers.push(compareHeading);
            }

            const rows = [headers.join(',')];

            for (let i = 0; i < results.gross.length; i++) {
                const xValue = results.gross[i];
                const yValue = ySeries[i];
                const row = [xValue, yValue];

                if (compareSeries && compareSeries[i] !== undefined) {
                    row.push(compareSeries[i]);
                }

                rows.push(row.join(','));
            }

            const csvContent = rows.join('\n');
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);

            const datasetSlug = this.slugifyLabel(this.selectedDataset);
            const chartSlug = this.slugifyLabel(this.chartType);
            const fileName = `${datasetSlug}-${chartSlug}.csv`;

            const tempLink = document.createElement('a');
            tempLink.href = url;
            tempLink.setAttribute('download', fileName);
            document.body.appendChild(tempLink);
            tempLink.click();
            document.body.removeChild(tempLink);
            URL.revokeObjectURL(url);
        },

        async downloadChartImage() {
            const chartElement = document.getElementById('plotly-chart');
            if (!chartElement || typeof Plotly === 'undefined') {
                return;
            }

            const rect = chartElement.getBoundingClientRect();
            const width = Math.max(400, Math.round(rect.width));
            const height = Math.max(300, Math.round(rect.height));
            const scale = Math.min(3, Math.max(1.5, window.devicePixelRatio || 2));

            try {
                const dataUrl = await Plotly.toImage(chartElement, {
                    format: 'png',
                    width,
                    height,
                    scale
                });

                const datasetSlug = this.slugifyLabel(this.selectedDataset);
                const chartSlug = this.slugifyLabel(this.chartType);
                const fileName = `${datasetSlug}-${chartSlug}-chart.png`;

                const link = document.createElement('a');
                link.href = dataUrl;
                link.setAttribute('download', fileName);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            } catch (error) {
                console.error('Unable to download chart image', error);
            }
        },

        slugifyLabel(label) {
            if (!label) return '';
            return label
                .toString()
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '_');
        },

        buildTrace(results, label, yKey, style) {
            return {
                x: results.gross,
                y: results[yKey],
                mode: 'lines',
                name: label,
                line: {
                    color: style.color,
                    dash: style.dash,
                    width: 3
                },
                hovertemplate: style.hoverTemplate
            };
        },

        /**
         * Resizes the chart to maintain a consistent aspect ratio.
         */
        resizeChart() {
            const chartContainer = document.getElementById('plotly-chart');
            if (chartContainer) {
                const containerWidth = chartContainer.offsetWidth;
                const preferredHeight = containerWidth * 0.6;
                const viewportCap = window.innerHeight * 0.75;
                const clampedHeight = Math.min(Math.max(preferredHeight, 320), viewportCap || preferredHeight);
                const isMobileViewport = window.matchMedia ? window.matchMedia('(max-width: 768px)').matches : false;
                const compareActive = this.compareDataset && this.compareDataset !== "None" && this.taxData[this.compareDataset];
                const legendState = !isMobileViewport && Boolean(compareActive);

                // Let Plotly handle the width automatically, then set a sensible height based on viewport size.
                const update = {
                    autosize: true,
                    height: clampedHeight,
                    showlegend: legendState
                };
                Plotly.relayout('plotly-chart', update);
            }
        },

        /**
         * Fetches the tax data from the JSON file.
         */
        async loadTaxData() {
            try {
                const response = await fetch('UK_marginal_tax_datasets.json');
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                this.taxData = await response.json();
                console.log("Tax data loaded successfully.");
            } catch (error) {
                console.error("Error loading tax data:", error);
                // You could display an error message to the user here
            }
        },

        applyCustomIncome() {
            const rawValue = typeof this.customIncomeInput === 'string'
                ? this.customIncomeInput.replace(/[^0-9.]/g, '')
                : this.customIncomeInput;
            const income = Number(rawValue);
            if ((!income && income !== 0) || income < 0 || !this.taxData[this.selectedDataset]) {
                return;
            }
            if (income === 0) {
                this.clearIncome();
                return;
            }
            this.customIncomeInput = income.toLocaleString();
            this.computeResultsForIncome(income, true);
        },

        computeResultsForIncome(income, refreshChart = false) {
            const selectedData = this.taxData[this.selectedDataset];
            if (!selectedData) return;

            this.updateMaxIncomeForValue(income);

            const childBenefitCredit = this.getChildBenefitAmount(selectedData);
            const { taxableIncome, employerNi } = this.transformIncomeForEmployment(income, selectedData);
            const childcareCredit = this.calculateChildcareSubsidy(income, selectedData, taxableIncome);
            const niTaxKey = this.getActiveNiKey();

            const incomeTaxDetails = this.calculateTaxAndNi(taxableIncome, this.selectedDataset, "income tax", true, 'actual');
            const niDetails = this.calculateTaxAndNi(taxableIncome, this.selectedDataset, niTaxKey, true, 'actual');

            const niTotalWithEmployer = niDetails.total + employerNi;
            const totalTax = incomeTaxDetails.total + niTotalWithEmployer;
            const childBenefitDisplayOffset = Math.min(childBenefitCredit, totalTax);
            const displayedTotalTax = totalTax - childBenefitDisplayOffset;
            const adjustedTotalTax = totalTax - childBenefitCredit - childcareCredit;
            const netIncome = income - adjustedTotalTax;

            this.latestPrimarySummary = {
                dataset: this.selectedDataset,
                income,
                netIncome,
                totalTax: displayedTotalTax,
                effectiveRate: income === 0 ? 0 : (adjustedTotalTax / income) * 100,
                marginalRate: null
            };

            const testTotals = this.calculateTotalAndAdjustedTax(income + this.PERTURBATION, this.selectedDataset);
            const marginalRate = ((testTotals.adjustedTax - adjustedTotalTax) / this.PERTURBATION) * 100;
            const effectiveRate = this.latestPrimarySummary.effectiveRate;
            this.latestPrimarySummary.marginalRate = marginalRate;

            this.summaryResults.afterTaxIncome = this.formatCurrency(netIncome);
            this.summaryResults.totalTax = this.formatCurrency(displayedTotalTax);
            this.summaryResults.effectiveRate = this.formatPercent(effectiveRate);
            this.summaryResults.marginalRate = this.formatPercent(marginalRate);
            this.displayedIncome = income;

            const formattedIncomeTaxBands = incomeTaxDetails.bands.map(band => ({
                label: band.label,
                amount: this.formatCurrency(band.amount)
            }));
            const incomeTaxBandTotal = incomeTaxDetails.bands.reduce((sum, band) => sum + band.amount, 0);

            const formattedNiBands = niDetails.bands.map(band => ({
                label: band.label,
                amount: this.formatCurrency(band.amount)
            }));
            if (employerNi > 0) {
                const employerNiLabel = this.employmentType === 'Within IR35'
                    ? "Employer NI (IR35)"
                    : "Employer NI (Partnership)";
                formattedNiBands.push({
                    label: employerNiLabel,
                    amount: this.formatCurrency(employerNi)
                });
            }

            const baseAdjustments = incomeTaxDetails.adjustments
                .map(adj => {
                    const type = adj.type || (adj.amount >= 0 ? 'credit' : 'debit');
                    return {
                        ...adj,
                        amount: Math.abs(adj.amount),
                        type
                    };
                });
            const adjustmentEntries = [...baseAdjustments];

            if (childBenefitCredit > 0) {
                adjustmentEntries.unshift({
                    label: "Child benefit",
                    amount: childBenefitCredit,
                    type: "credit"
                });
            }
            if (childcareCredit > 0) {
                adjustmentEntries.push({
                    label: "Childcare subsidy",
                    amount: childcareCredit,
                    type: "credit"
                });
            }

            const formattedAdjustments = adjustmentEntries.map(adj => this.formatAdjustmentEntry(adj));

            const personalAllowanceValue = Math.round(
                incomeTaxDetails.personalAllowance ?? this.taxData[this.selectedDataset]["statutory personal allowance"] ?? 0
            );
            const adjustmentsTotal =
                formattedAdjustments.reduce((sum, adj) => sum + adj.rawAmount, 0);

            this.detailResults = {
                incomeTaxBands: formattedIncomeTaxBands,
                incomeTaxTotal: this.formatCurrency(incomeTaxBandTotal),
                niBands: formattedNiBands,
                niTotal: this.formatCurrency(niTotalWithEmployer),
                personalAllowance: personalAllowanceValue,
                adjustments: formattedAdjustments.map(({ rawAmount, ...rest }) => rest),
                adjustmentsTotal: `${adjustmentsTotal > 0 ? '+' : adjustmentsTotal < 0 ? '-' : ''}${this.formatCurrency(Math.abs(adjustmentsTotal))}`
            };

            this.updateComparisonCard(income);

            if (refreshChart) {
                this.updateChart();
            }
        },

        calculateTotalAndAdjustedTax(grossIncome, rulesetName) {
            if (grossIncome < 0) grossIncome = 0;
            const dataset = this.taxData[rulesetName];
            if (!dataset) {
                return { totalTax: 0, adjustedTax: 0 };
            }
            const { taxableIncome, employerNi } = this.transformIncomeForEmployment(grossIncome, dataset);
            const childBenefitCredit = this.getChildBenefitAmount(dataset);
            const childcareCredit = this.calculateChildcareSubsidy(grossIncome, dataset, taxableIncome);
            const niTaxKey = this.getActiveNiKey();
            const incomeTax = this.calculateTaxAndNi(taxableIncome, rulesetName, "income tax", false, 'actual');
            const nationalInsurance = this.calculateTaxAndNi(taxableIncome, rulesetName, niTaxKey, false, 'actual');
            const totalTax = incomeTax + nationalInsurance + employerNi;
            return {
                totalTax,
                adjustedTax: totalTax - childBenefitCredit - childcareCredit
            };
        },

        formatAdjustmentEntry(entry) {
            const isCredit = entry.type === 'credit';
            const isDebit = entry.type === 'debit';
            const absoluteAmount = Math.abs(entry.amount);
            const sign = isCredit ? '+' : isDebit ? '-' : entry.amount > 0 ? '+' : entry.amount < 0 ? '-' : '';
            const rawAmount = isCredit ? absoluteAmount : isDebit ? -absoluteAmount : entry.amount;
            return {
                label: entry.label,
                amount: `${sign}${this.formatCurrency(absoluteAmount)}`,
                type: entry.type,
                rawAmount
            };
        },

        calculateSummaryMetrics(datasetName, income) {
            const dataset = this.taxData[datasetName];
            if (!dataset) return null;

            const childBenefitCredit = this.getChildBenefitAmount(dataset);
            const { taxableIncome, employerNi } = this.transformIncomeForEmployment(income, dataset);
            const childcareCredit = this.calculateChildcareSubsidy(income, dataset, taxableIncome);
            const niTaxKey = this.getActiveNiKey();
            const incomeTax = this.calculateTaxAndNi(taxableIncome, datasetName, "income tax", false, 'actual');
            const nationalInsurance = this.calculateTaxAndNi(taxableIncome, datasetName, niTaxKey, false, 'actual');
            const totalTax = incomeTax + nationalInsurance + employerNi;
            const childBenefitDisplayOffset = Math.min(childBenefitCredit, totalTax);
            const displayedTotalTax = totalTax - childBenefitDisplayOffset;
            const adjustedTotalTax = totalTax - childBenefitCredit - childcareCredit;
            const netIncome = income - adjustedTotalTax;

            const testTotals = this.calculateTotalAndAdjustedTax(income + this.PERTURBATION, datasetName);
            const marginalRate = ((testTotals.adjustedTax - adjustedTotalTax) / this.PERTURBATION) * 100;
            const effectiveRate = income === 0 ? 0 : (adjustedTotalTax / income) * 100;

            return { dataset: datasetName, income, netIncome, totalTax: displayedTotalTax, effectiveRate, marginalRate };
        },

        updateComparisonCard(income) {
            if (!this.compareDataset || this.compareDataset === "None" || !this.latestPrimarySummary) {
                this.comparisonResults = null;
                return;
            }

            const compareSummary = this.calculateSummaryMetrics(this.compareDataset, income);
            if (!compareSummary) {
                this.comparisonResults = null;
                return;
            }

            const deltaAfterTax = compareSummary.netIncome - this.latestPrimarySummary.netIncome;
            const deltaTotalTax = compareSummary.totalTax - this.latestPrimarySummary.totalTax;

            this.comparisonResults = {
                datasetName: this.compareDataset,
                afterTax: { value: this.formatDeltaCurrency(deltaAfterTax), negative: deltaAfterTax < 0 },
                totalTax: { value: this.formatCurrency(compareSummary.totalTax) },
                effectiveRate: { value: this.formatPercent(compareSummary.effectiveRate) },
                marginalRate: { value: this.formatPercent(compareSummary.marginalRate) }
            };
        },

        formatDeltaCurrency(value) {
            if (value === null || value === undefined) return "-";
            const sign = value > 0 ? '+' : value < 0 ? '-' : '';
            return `${sign}${this.formatCurrency(Math.abs(value))}`;
        },

        formatDeltaPercent(value) {
            if (value === null || value === undefined) return "-";
            const sign = value > 0 ? '+' : value < 0 ? '-' : '';
            return `${sign}${Math.abs(value).toFixed(1)}%`;
        },

        flipDatasets() {
            if (!this.compareDataset || this.compareDataset === "None") {
                return;
            }
            const currentMain = this.selectedDataset;
            this.selectedDataset = this.compareDataset;
            this.compareDataset = currentMain || "None";
        },

        getSummaryForIncome(dataset, income) {
            if (
                this.latestPrimarySummary &&
                this.latestPrimarySummary.dataset === dataset &&
                this.latestPrimarySummary.income === income
            ) {
                return this.latestPrimarySummary;
            }
            return this.calculateSummaryMetrics(dataset, income);
        },

        getChartValueForSummary(summary, chartType) {
            if (!summary) return null;
            if (chartType === 'Marginal rate') {
                return summary.marginalRate;
            }
            if (chartType === 'Effective rate') {
                return summary.effectiveRate;
            }
            return summary.netIncome;
        },

        getChartLabel(chartType) {
            if (chartType === 'Marginal rate') return 'Marginal tax rate';
            if (chartType === 'Effective rate') return 'Effective tax rate';
            return 'Net income';
        },

        formatChartValue(value, chartType) {
            if (value === null || value === undefined) return '-';
            if (chartType === 'Net v gross') {
                return this.formatCurrency(value);
            }
            return `${value.toFixed(1)}%`;
        },

        runWithoutScrollJump(action) {
            action();
        },

        clearIncome() {
            this.customIncomeInput = null;
            this.displayedIncome = null;
            this.latestPrimarySummary = null;
            this.summaryResults = {
                afterTaxIncome: "-",
                totalTax: "-",
                effectiveRate: "-",
                marginalRate: "-"
            };
            this.detailResults = {
                incomeTaxBands: [],
                incomeTaxTotal: "-",
                niBands: [],
                niTotal: "-",
                personalAllowance: 0,
                adjustments: [],
                adjustmentsTotal: "-"
            };
            this.comparisonResults = null;
            this.resetChartMaxIncome();
            this.updateChart();
        }
    },

    // =====================
    //  Lifecycle Hook
    // =====================
    async mounted() {
        // Load the external tax data first
        await this.loadTaxData();

        // Then draw the initial chart
        this.updateChart();

        // Add a listener to redraw the chart on window resize
        window.addEventListener('resize', this.resizeChart);
    }
}).mount('#app');
