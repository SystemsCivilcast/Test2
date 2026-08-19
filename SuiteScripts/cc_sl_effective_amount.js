/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Effective Amount viewer.
 *
 * Shows transaction lines with the billed/effective amount formula:
 *
 *   CASE WHEN {closed} = 'T' or {quantity} = 0
 *        THEN (CASE WHEN {item} = 'Package Discount' THEN {amount}
 *                   ELSE {rate} * {quantitybilled} END)
 *        ELSE {amount} END
 */
define(['N/search', 'N/ui/serverWidget', 'N/log'], function (search, serverWidget, log) {

    var EFFECTIVE_AMOUNT_FORMULA =
        "CASE WHEN {closed} = 'T' or {quantity} = 0 " +
        "THEN (CASE WHEN {item} = 'Package Discount' THEN {amount} ELSE {rate} * {quantitybilled} END) " +
        "ELSE {amount} END";

    var MAX_ROWS = 5000;   // guard rail so the page stays inside governance
    var PAGE_SIZE = 1000;

    function onRequest(context) {
        var params = context.request.parameters || {};
        // Only search once the user has asked for it, so opening the Suitelet
        // cold does not fire an unfiltered transaction search.
        var shouldRun = context.request.method === 'POST' || params.custpage_run === 'T';

        var rows = [];
        var error = null;

        if (shouldRun) {
            try {
                rows = runSearch(params);
            } catch (e) {
                log.error({ title: 'Effective Amount search failed', details: e });
                error = e.message || String(e);
            }
        }

        var form = serverWidget.createForm({ title: 'Effective Amount by Line' });

        if (error) {
            form.addField({
                id: 'custpage_error',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Error'
            }).defaultValue = '<p style="color:#c00;font-weight:bold;">Search failed: ' +
                escapeHtml(error) + '</p>';
        }

        addFilters(form, params);
        form.addSubmitButton({ label: 'Run' });

        var label = shouldRun && !error
            ? 'Results (' + rows.length + (rows.length >= MAX_ROWS ? '+, truncated' : '') + ')'
            : 'Results';
        var sublist = addSublist(form, label);
        populate(sublist, rows);

        context.response.writePage(form);
    }

    function addFilters(form, params) {
        form.addFieldGroup({ id: 'custpage_grp_filters', label: 'Filters' });

        var type = form.addField({
            id: 'custpage_type',
            type: serverWidget.FieldType.SELECT,
            label: 'Transaction Type',
            container: 'custpage_grp_filters'
        });
        type.addSelectOption({ value: '', text: '- All -' });
        type.addSelectOption({ value: 'SalesOrd', text: 'Sales Order' });
        type.addSelectOption({ value: 'PurchOrd', text: 'Purchase Order' });
        type.addSelectOption({ value: 'CustInvc', text: 'Invoice' });
        type.addSelectOption({ value: 'ItemShip', text: 'Item Fulfilment' });
        type.defaultValue = params.custpage_type || 'SalesOrd';

        form.addField({
            id: 'custpage_datefrom',
            type: serverWidget.FieldType.DATE,
            label: 'Date From',
            container: 'custpage_grp_filters'
        }).defaultValue = params.custpage_datefrom || '';

        form.addField({
            id: 'custpage_dateto',
            type: serverWidget.FieldType.DATE,
            label: 'Date To',
            container: 'custpage_grp_filters'
        }).defaultValue = params.custpage_dateto || '';

        form.addField({
            id: 'custpage_docnum',
            type: serverWidget.FieldType.TEXT,
            label: 'Document Number (contains)',
            container: 'custpage_grp_filters'
        }).defaultValue = params.custpage_docnum || '';

        var run = form.addField({
            id: 'custpage_run',
            type: serverWidget.FieldType.TEXT,
            label: 'Run'
        });
        run.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        run.defaultValue = 'T';
    }

    function addSublist(form, label) {
        var sublist = form.addSublist({
            id: 'custpage_results',
            type: serverWidget.SublistType.LIST,
            label: label
        });

        sublist.addField({ id: 'custpage_col_date', type: serverWidget.FieldType.TEXT, label: 'Date' });
        sublist.addField({ id: 'custpage_col_type', type: serverWidget.FieldType.TEXT, label: 'Type' });
        sublist.addField({ id: 'custpage_col_doc', type: serverWidget.FieldType.TEXT, label: 'Document #' });
        sublist.addField({ id: 'custpage_col_entity', type: serverWidget.FieldType.TEXT, label: 'Name' });
        sublist.addField({ id: 'custpage_col_item', type: serverWidget.FieldType.TEXT, label: 'Item' });
        sublist.addField({ id: 'custpage_col_closed', type: serverWidget.FieldType.TEXT, label: 'Closed' });
        sublist.addField({ id: 'custpage_col_qty', type: serverWidget.FieldType.TEXT, label: 'Quantity' });
        sublist.addField({ id: 'custpage_col_qtybilled', type: serverWidget.FieldType.TEXT, label: 'Qty Billed' });
        sublist.addField({ id: 'custpage_col_rate', type: serverWidget.FieldType.TEXT, label: 'Rate' });
        sublist.addField({ id: 'custpage_col_amount', type: serverWidget.FieldType.TEXT, label: 'Amount' });
        sublist.addField({ id: 'custpage_col_effective', type: serverWidget.FieldType.TEXT, label: 'Effective Amount' });

        return sublist;
    }

    function runSearch(params) {
        var filters = [
            ['mainline', search.Operator.IS, 'F'],
            'AND', ['taxline', search.Operator.IS, 'F'],
            'AND', ['shipping', search.Operator.IS, 'F']
        ];

        if (params.custpage_type) {
            filters.push('AND', ['type', search.Operator.ANYOF, params.custpage_type]);
        }
        if (params.custpage_datefrom && params.custpage_dateto) {
            filters.push('AND', ['trandate', search.Operator.WITHIN, params.custpage_datefrom, params.custpage_dateto]);
        } else if (params.custpage_datefrom) {
            filters.push('AND', ['trandate', search.Operator.ONORAFTER, params.custpage_datefrom]);
        } else if (params.custpage_dateto) {
            filters.push('AND', ['trandate', search.Operator.ONORBEFORE, params.custpage_dateto]);
        }
        if (params.custpage_docnum) {
            filters.push('AND', ['numbertext', search.Operator.CONTAINS, params.custpage_docnum]);
        }

        // Keep the column objects around - a formula column has to be read back
        // with the same column object, not by name.
        var cols = {
            date:      search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
            type:      search.createColumn({ name: 'type' }),
            doc:       search.createColumn({ name: 'tranid' }),
            entity:    search.createColumn({ name: 'entity' }),
            item:      search.createColumn({ name: 'item' }),
            closed:    search.createColumn({ name: 'closed' }),
            qty:       search.createColumn({ name: 'quantity' }),
            qtybilled: search.createColumn({ name: 'quantitybilled' }),
            rate:      search.createColumn({ name: 'rate' }),
            amount:    search.createColumn({ name: 'amount' }),
            effective: search.createColumn({
                name: 'formulacurrency',
                formula: EFFECTIVE_AMOUNT_FORMULA,
                label: 'Effective Amount'
            })
        };

        var srch = search.create({
            type: search.Type.TRANSACTION,
            filters: filters,
            columns: [cols.date, cols.type, cols.doc, cols.entity, cols.item,
                      cols.closed, cols.qty, cols.qtybilled, cols.rate, cols.amount, cols.effective]
        });

        var rows = [];
        var paged = srch.runPaged({ pageSize: PAGE_SIZE });

        paged.pageRanges.forEach(function (range) {
            if (rows.length >= MAX_ROWS) return;
            paged.fetch({ index: range.index }).data.forEach(function (r) {
                if (rows.length >= MAX_ROWS) return;
                var closed = r.getValue(cols.closed);
                rows.push({
                    date:      r.getValue(cols.date),
                    type:      r.getText(cols.type) || r.getValue(cols.type),
                    doc:       r.getValue(cols.doc),
                    entity:    r.getText(cols.entity) || r.getValue(cols.entity),
                    item:      r.getText(cols.item) || r.getValue(cols.item),
                    closed:    (closed === true || closed === 'T') ? 'Yes' : 'No',
                    qty:       r.getValue(cols.qty),
                    qtybilled: r.getValue(cols.qtybilled),
                    rate:      r.getValue(cols.rate),
                    amount:    r.getValue(cols.amount),
                    effective: r.getValue(cols.effective)
                });
            });
        });

        return rows;
    }

    function populate(sublist, rows) {
        var total = 0;

        rows.forEach(function (row, i) {
            setLine(sublist, 'custpage_col_date', i, row.date);
            setLine(sublist, 'custpage_col_type', i, row.type);
            setLine(sublist, 'custpage_col_doc', i, row.doc);
            setLine(sublist, 'custpage_col_entity', i, row.entity);
            setLine(sublist, 'custpage_col_item', i, row.item);
            setLine(sublist, 'custpage_col_closed', i, row.closed);
            setLine(sublist, 'custpage_col_qty', i, num(row.qty));
            setLine(sublist, 'custpage_col_qtybilled', i, num(row.qtybilled));
            setLine(sublist, 'custpage_col_rate', i, num(row.rate));
            setLine(sublist, 'custpage_col_amount', i, num(row.amount));
            setLine(sublist, 'custpage_col_effective', i, num(row.effective));

            total += parseFloat(row.effective) || 0;
        });

        if (rows.length) {
            setLine(sublist, 'custpage_col_item', rows.length, 'TOTAL');
            setLine(sublist, 'custpage_col_effective', rows.length, num(total));
        }
    }

    function setLine(sublist, id, line, value) {
        if (value === null || value === undefined || value === '') return;
        sublist.setSublistValue({ id: id, line: line, value: String(value) });
    }

    function num(value) {
        var n = parseFloat(value);
        return isNaN(n) ? '' : n.toFixed(2);
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    return { onRequest: onRequest };
});
