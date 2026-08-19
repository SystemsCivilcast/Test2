/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Read-only "This Year" revenue widget.
 *
 * Sums the billed/effective amount formula for the current year to date and
 * shows the same period last year underneath:
 *
 *   CASE WHEN {closed} = 'T' or {quantity} = 0
 *        THEN (CASE WHEN {item} = 'Package Discount' THEN {amount}
 *                   ELSE {rate} * {quantitybilled} END)
 *        ELSE {amount} END
 *
 * Designed to sit in a Custom Content dashboard portlet pointed at the
 * deployment URL. No filters, no inputs - display only.
 */
define(['N/search', 'N/format', 'N/log'], function (search, format, log) {

    var EFFECTIVE_AMOUNT_FORMULA =
        "CASE WHEN {closed} = 'T' or {quantity} = 0 " +
        "THEN (CASE WHEN {item} = 'Package Discount' THEN {amount} ELSE {rate} * {quantitybilled} END) " +
        "ELSE {amount} END";

    // ---- Configuration ------------------------------------------------------
    var TRANSACTION_TYPES = ['SalesOrd'];   // types included in the total
    var FISCAL_YEAR_START_MONTH = 1;        // 1 = calendar year, 7 = Jul-Jun FY
    var LIKE_FOR_LIKE = true;               // true = prior year to same date,
                                            // false = the full prior year
    var HEADING = 'THIS YEAR';
    // -------------------------------------------------------------------------

    function onRequest(context) {
        var current = buildPeriod(0);
        var prior = buildPeriod(1);

        try {
            current.total = sumEffectiveAmount(current.start, current.end);
            prior.total = sumEffectiveAmount(prior.start, prior.end);
        } catch (e) {
            log.error({ title: 'Effective Amount widget failed', details: e });
        }

        context.response.write({ output: render(current, prior) });
    }

    /**
     * Period 0 is the current year to date, period 1 the same window a year
     * back (or the whole prior year when LIKE_FOR_LIKE is off).
     */
    function buildPeriod(yearsBack) {
        var today = new Date();
        var startYear = today.getFullYear() - yearsBack;

        // Before the fiscal year rolls over we are still inside the year that
        // started last calendar year.
        if (today.getMonth() + 1 < FISCAL_YEAR_START_MONTH) {
            startYear -= 1;
        }

        var start = new Date(startYear, FISCAL_YEAR_START_MONTH - 1, 1);
        var end;

        if (yearsBack === 0) {
            end = today;
        } else if (LIKE_FOR_LIKE) {
            end = new Date(today.getFullYear() - yearsBack, today.getMonth(), today.getDate());
        } else {
            end = new Date(startYear + 1, FISCAL_YEAR_START_MONTH - 1, 0); // day before it rolls
        }

        return { label: periodLabel(startYear), start: start, end: end, total: null };
    }

    function periodLabel(startYear) {
        if (FISCAL_YEAR_START_MONTH === 1) {
            return String(startYear);
        }
        return 'FY' + String((startYear + 1) % 100 + 100).slice(1);
    }

    function sumEffectiveAmount(startDate, endDate) {
        var filters = [
            ['mainline', search.Operator.IS, 'F'],
            'AND', ['taxline', search.Operator.IS, 'F'],
            'AND', ['shipping', search.Operator.IS, 'F'],
            'AND', ['type', search.Operator.ANYOF, TRANSACTION_TYPES],
            'AND', ['trandate', search.Operator.WITHIN, toSearchDate(startDate), toSearchDate(endDate)]
        ];

        // A formula column has to be read back with the same column object,
        // not by name.
        var totalColumn = search.createColumn({
            name: 'formulacurrency',
            formula: EFFECTIVE_AMOUNT_FORMULA,
            summary: search.Summary.SUM
        });

        var results = search.create({
            type: search.Type.TRANSACTION,
            filters: filters,
            columns: [totalColumn]
        }).run().getRange({ start: 0, end: 1 });

        if (!results.length) {
            return 0;
        }

        return parseFloat(results[0].getValue(totalColumn)) || 0;
    }

    function toSearchDate(date) {
        return format.format({ value: date, type: format.Type.DATE });
    }

    function render(current, prior) {
        return '<!DOCTYPE html>' +
            '<html><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<style>' +
            'html,body{margin:0;padding:0;background:#0f151d;' +
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
            '.wrap{padding:14px 16px 18px;}' +
            '.heading{color:#8b95a5;font-size:11px;font-weight:700;letter-spacing:1.4px;' +
            'text-align:center;margin:0 0 12px;}' +
            '.card{background:#161d27;border:1px solid #263041;border-radius:10px;padding:16px 18px 14px;}' +
            '.year{color:#8b95a5;font-size:12px;font-weight:700;margin-bottom:4px;}' +
            '.value{color:#f2f5f9;font-size:36px;font-weight:700;letter-spacing:-0.5px;line-height:1.1;}' +
            '.prior{border-top:1px solid #263041;margin-top:14px;padding-top:10px;' +
            'color:#8b95a5;font-size:13px;}' +
            '.prior .prior-year{font-weight:700;margin-right:10px;}' +
            '</style></head><body>' +
            '<div class="wrap">' +
            '<div class="heading">' + escapeHtml(HEADING) + '</div>' +
            '<div class="card">' +
            '<div class="year">' + escapeHtml(current.label) + '</div>' +
            '<div class="value">' + money(current.total) + '</div>' +
            '<div class="prior">' +
            '<span class="prior-year">' + escapeHtml(prior.label) + '</span>' +
            '<span>' + money(prior.total) + '</span>' +
            '</div>' +
            '</div></div></body></html>';
    }

    function money(value) {
        if (value === null || value === undefined || isNaN(value)) {
            return '&mdash;';
        }
        var rounded = Math.round(Math.abs(value)).toString();
        var withCommas = rounded.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (value < 0 ? '-$' : '$') + withCommas;
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    return { onRequest: onRequest };
});
