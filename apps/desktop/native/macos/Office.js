/* global ObjC, Application, Path, $ */
/* eslint no-control-regex: "off" -- Reject control characters and preserve Office paragraph boundaries. */
// Fixed Apple Events operations. Request values remain data, never script source.
ObjC.import('Foundation');
ObjC.import('AppKit');
function fail(message) { throw new Error(message); }
function path(value) {
    if (typeof value !== 'string') return '';
    if (value[0] === '/') return value;
    // Office still returns HFS paths on some releases.
    let parts = value.split(':');
    if (parts.length < 2) return value;
    let root = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath('/'));
    return (parts[0] === root ? '' : '/Volumes/' + parts[0]) + '/' + parts.slice(1).join('/');
}
function rgb(value) { return value.replace(/^#/, '').match(/../g).map(function (x) { return parseInt(x, 16) * 257; }); }
function range(sheet, value) {
    if (typeof value !== 'string' || !/^\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}(?::\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6})?$/i.test(value)) fail('Use a bounded A1 range');
    let r = sheet.ranges[value];
    if (r.rows.length * r.columns.length > 4000) fail('Read or write at most 4000 cells');
    return r;
}
function unique(items, matches) {
    let found = (items || []).filter(matches);
    if (found.length !== 1) fail('Name one existing document explicitly');
    return found[0];
}
function excel(op, a) {
    let app = Application('Microsoft Excel');
    if (op === 'excel.workbooks') return {workbooks: app.workbooks().map(function (w) { return {name:w.name(),path:path(w.fullName()),sheets:w.worksheets.name(),active:false}; })};
    let wb = a.workbook === 'new' && op === 'excel.write' ? app.Workbook().make() : unique(app.workbooks(), function(w) { return w.name() === a.workbook || path(w.fullName()) === a.workbook; });
    if (wb.hasVbProject() || wb.readOnly()) fail('Read-only and macro-enabled documents require manual control');
    let matches = wb.worksheets().filter(function(s) { return s.name() === a.sheet; });
    let sheet;
    if (matches.length === 1) sheet = matches[0];
    else if (!matches.length && op === 'excel.write' && typeof a.sheet === 'string' && a.sheet) {
        sheet = app.make({new:'worksheet',at:wb});
        sheet.name = a.sheet;
        sheet = wb.worksheets.byName(a.sheet);
    } else fail('Name one worksheet explicitly');
    if (sheet.protectContents()) fail('Protected worksheets require manual control');
    if (op === 'excel.read') {
        let read = range(sheet,a.range), rows = read.value(), formulas = read.formula();
        return {workbook:wb.name(),sheet:sheet.name(),range:a.range,rows:Array.isArray(rows)?rows:[[rows]],formulas:Array.isArray(formulas)?formulas:[[formulas]]};
    }
    let written = 0;
    (a.cells || []).forEach(function(c) {
        let cell = range(sheet,c.cell);
        if (typeof c.value === 'string' && c.value[0] === '=') { localFormula(c.value); cell.formula = c.value; }
        else cell.value = c.value;
        written++;
    });
    (a.formats || []).forEach(function(f) {
        let r = range(sheet,f.range);
        if (f.numberFormat !== undefined) r.numberFormat = f.numberFormat;
        if (f.bold !== undefined) r.fontObject.bold = f.bold;
        if (f.italic !== undefined) r.fontObject.italic = f.italic;
        if (f.size !== undefined) r.fontObject.fontSize = f.size;
        if (f.fill !== undefined) r.interiorObject.color = rgb(f.fill);
        if (f.fontColor !== undefined) r.fontObject.color = rgb(f.fontColor);
        if (f.align) r.horizontalAlignment = 'horizontal align ' + f.align;
        if (f.border) r.borders().forEach(function(b) { b.lineStyle='continuous'; b.weight='border weight thin'; });
        if (f.autofit) app.autofit(r.entireColumn);
    });
    (a.charts || []).forEach(function(c) {
        let object = app.make({new:'chart object',at:sheet,withProperties:{leftPosition:c.left || 320,top:c.top || 20,width:c.width || 420,height:c.height || 260}});
        let chart = object.chart;
        chart.chartType = {column:'column clustered',bar:'bar clustered',line:'line',pie:'pie'}[c.type || 'column'];
        app.setSourceData(chart,{source:range(sheet,c.data)});
        if (c.title !== undefined) {chart.hasTitle=true;chart.chartTitle.text=c.title;}
        written++;
    });
    let saved = null;
    if (a.saveAs) { app.saveWorkbookAs(wb,{filename:a.saveAs,fileFormat:'Excel XML file format'}); saved=a.saveAs; }
    else if (a.save) { app.save(wb); saved=path(wb.fullName()); }
    return {workbook:wb.name(),sheet:sheet.name(),written:written,saved:saved};
}
function documentState(doc, kind) {
    if (kind === 'word') {
        let text = doc.textObject.content();
        if(text.length>100000) fail('Main body exceeds 100000 characters');
        return [{key:'body',text:text}];
    }
    let items=[], size=0;
    doc.slides().forEach(function(slide,si) {
        slide.shapes().forEach(function(shape, index) {
            if(shape.hasTextFrame()) {let text=shape.textFrame.textRange.content();size+=text.length;items.push({key:(si+1)+':'+(index+1),slide:si+1,shape:index+1,id:shape.name(),text:text});}
        });
        slide.notesPage.placeHolders().forEach(function(shape) {
            if(shape.hasTextFrame() && String(shape.placeholderType()) === 'placeholder type body placeholder') {
                let text=shape.textFrame.textRange.content();size+=text.length;items.push({key:(si+1)+':note',slide:si+1,id:String(slide.slideID()),text:text});
            }
        });
        if(items.length>500 || size>100000) fail('Presentation exceeds 500 text targets or 100000 characters');
    });
    return items;
}
function documentObject(app,kind,file) {
    let documents=kind==='word'?app.documents:app.presentations;
    let found=(documents() || []).filter(function(d){return path(d.fullName())===file;});
    if(found.length===1)return found[0];
    if(found.length>1)fail('Ambiguous document identity');
    let security=app.automationSecurity();
    try {app.automationSecurity='msoAutomationSecurityForceDisable';app.open(Path(file));}
    finally {app.automationSecurity=security;}
    return unique(documents(),function(d){return path(d.fullName())===file;});
}
function documentOperation(op,a) {
    let kind=op.split('.')[0], app=Application(kind==='word'?'Microsoft Word':'Microsoft PowerPoint');
    let doc=documentObject(app,kind,a.file), state=documentState(doc,kind);
    if(op.endsWith('.read'))return {file:a.file,content:state};
    if(doc.readOnly())fail('Read-only documents require manual control');
    if(JSON.stringify(state)!==JSON.stringify(a.expected))fail('Document changed. Read again before editing');
    // Plans are validated before the first write; the caller consumes the revision first.
    (a.plan||[]).forEach(function(step){
        let current=documentState(doc,kind).filter(function(s){return s.key===step.key;})[0];
        if(!current || current.text!==step.before)fail('Document changed during editing');
        let target;
        if(kind==='word')target=doc.textObject;
        else {
            let parts=step.key.split(':'), slide=doc.slides[Number(parts[0])-1];
            if(parts[1]==='note') {
                let note=unique(slide.notesPage.placeHolders(),function(s){return s.hasTextFrame() && String(s.placeholderType())==='placeholder type body placeholder';});
                target=note.textFrame.textRange;
            } else target=slide.shapes[Number(parts[1])-1].textFrame.textRange;
        }
        if (step.mode === 'replace') {
            step.positions.slice().reverse().forEach(function(at) {
                if(kind==='word')app.createRange(doc,{start:target.startOfContent()+at,end:target.startOfContent()+at+step.find.length}).content=step.text;
                else target.characters.slice(at,at+step.find.length).content=step.text;
            });
        } else if (kind === 'word' && step.mode === 'append') {
            let end=target.endOfContent()-1;
            app.createRange(doc,{start:end,end:end}).content='\r'+step.text;
        } else target.content=step.after;
    });
    if(a.saveAs) {
        if(kind==='word')app.saveAs(doc,{fileName:a.saveAs,fileFormat:'format document default'});
        else app.save(doc,{in:Path(a.saveAs)});
    } else if(a.save)app.save(doc);
    return {file:a.file,applied:(a.plan||[]).length,saved:a.saveAs||(a.save?a.file:null),content:documentState(doc,kind)};
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- osascript calls this entry point.
function run(argv) {
    let data=ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0],$.NSUTF8StringEncoding,null));
    let request=JSON.parse(data), op=request.op,a=request.args;
    let result;
    if(op.indexOf('document')===0)result=liveDocument(op,a);
    else if(op==='resolve')result=resolveOffice(a);
    else if(op.indexOf('outlook.')===0)result=outlook(op,a);
    else if(op.indexOf('excel.')===0)result=excel(op,a);
    else if(op.indexOf('word.')===0 || op.indexOf('ppt.')===0)result=documentOperation(op,a);
    else fail('Unsupported Office operation');
    return JSON.stringify(result);
}

function resolveOffice(a) {
    let op=a.operation,kind=op.split('.')[0],app=Application(kind==='excel'?'Microsoft Excel':kind==='word'?'Microsoft Word':'Microsoft PowerPoint');
    let doc;
    if(kind==='excel')doc=a.workbook==='new'?app.Workbook().make():unique(app.workbooks(),function(w){return w.name()===a.workbook || path(w.fullName())===a.workbook;});
    else doc=documentObject(app,kind,a.file);
    let running=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.microsoft.'+(kind==='ppt'?'Powerpoint':kind==='word'?'Word':'Excel'));
    if(running.count!==1)fail('Cannot identify one Office application process');
    return {name:doc.name(),pid:Number(running.objectAtIndex(0).processIdentifier),workbook:kind==='excel'?doc.name():null};
}
function outlook(op,a) {
    let app=Application('Microsoft Outlook');
    function cap(value,n){return String(value||'').slice(0,n);}
    function recipients(message,cc){return (cc?message.ccRecipients():message.toRecipients()).map(function(r){let e=r.emailAddress();return e.address||e.name||'';}).join('; ');}
    function message(id){if(!/^[0-9]+$/.test(String(id)))fail('Invalid message ID');return app.messages.byId(Number(id));}
    function summary(m){let sender=m.sender();return {id:String(m.id()),subject:cap(m.subject(),300),from:cap(sender.name||sender.address,200),to:cap(recipients(m,false),500),received:m.timeReceived().toISOString()};}
    if(op==='outlook.mail') {
        let folder=a.folder==='sent'?app.sentItems:a.folder==='drafts'?app.drafts:!a.folder||a.folder==='inbox'?app.inbox:unique(app.mailFolders(),function(f){return f.name()===a.folder;});
        let items=folder.messages()||[],out=[],search=String(a.search||'').toLowerCase(),limit=Math.min(50,Math.max(1,a.limit||20));
        // Limit provider traffic on large mailboxes; newest local IDs are visited first.
        items.sort(function(l,r){return r.id()-l.id();});
        for(let i=0;i<items.length && out.length<limit;i++) {
            let m=items[i],entry=summary(m),hay=JSON.stringify(entry).toLowerCase();
            if(search && hay.indexOf(search)<0 && cap(m.plainTextContent(),20000).toLowerCase().indexOf(search)<0)continue;
            out.push(entry);
        }
        return {folder:folder.name(),count:out.length,mail:out};
    }
    if(op==='outlook.read') {
        let m=message(a.id),entry=summary(m);
        if(m.smimeEncrypted() || m.isRightsProtected())fail('Protected mail requires manual access');
        entry.body=cap(m.plainTextContent(),20000);
        entry.attachments=m.attachments().map(function(f){return {name:f.name(),size:f.fileSize()};});
        return entry;
    }
    if(op==='outlook.draft') {
        let draft;
        if(a.replyTo)draft=app.replyTo(message(a.replyTo),{openingWindow:false,replyToAll:a.replyAll===true});
        else draft=app.OutgoingMessage({subject:a.subject||'',plainTextContent:a.body||''}).make();
        if(a.replyTo)draft.plainTextContent=(a.body||'')+'\n\n'+draft.plainTextContent();
        if(a.subject!==undefined)draft.subject=a.subject;
        function add(value,cc){if(!value)return;String(value).split(/[;,]/).map(function(x){return x.trim();}).filter(Boolean).forEach(function(address){app.make({new:cc?'cc recipient':'to recipient',at:draft,withProperties:{emailAddress:{address:address}}});});}
        add(a.to,false);add(a.cc,true);
        app.save(draft);app.open(draft);
        return {id:String(draft.id()),subject:draft.subject(),to:recipients(draft,false),opened:true};
    }
    if(op==='outlook.calendar') {
        let start=a.from?new Date(a.from+'T00:00:00'):new Date();start.setHours(0,0,0,0);let end=new Date(start);end.setDate(end.getDate()+Math.min(60,Math.max(1,a.days||7)));
        if(!isFinite(start.getTime())||!isFinite(end.getTime())||end<=start)fail('Invalid calendar dates');
        let events=app.calendarEvents.whose({_and:[{startTime:{_greaterThanEquals:start}},{startTime:{_lessThan:end}}]})()||[];
        return {from:a.from||start.toISOString().slice(0,10),days:a.days||7,count:Math.min(100,events.length),events:events.slice(0,100).map(function(e){return {subject:cap(e.subject(),200),start:e.startTime().toISOString(),end:e.endTime().toISOString(),location:cap(e.location(),120),organizer:cap(e.organizer(),100)};})};
    }
    fail('Unsupported Outlook operation');
}
function liveContext(a) {
    let kind={'com.microsoft.Word':'word','com.microsoft.Excel':'excel','com.microsoft.Powerpoint':'powerpoint'}[a.bundle];
    if(!kind)fail('Unsupported live document app');
    let app=Application(a.bundle),doc=kind==='word'?app.activeDocument():kind==='excel'?app.activeWorkbook():app.activePresentation();
    if(!doc || !a.windowTitle || a.windowTitle.indexOf(doc.name())!==0)fail('The active document does not match the selected window');
    if(doc.readOnly())fail('Read-only documents require manual control');
    if(/\.(docm|dotm|pptm|potm|ppam)$/i.test(path(doc.fullName())))fail('Macro-enabled documents require manual control');
    let sheet=kind==='excel'?doc.activeSheet():null;
    if(kind==='excel' && (doc.hasVbProject() || sheet.protectContents()))fail('Protected or macro-enabled workbooks require manual control');
    if(kind==='word' && String(doc.protectionType())!=='no protection')fail('Protected documents require manual control');
    let identity=JSON.stringify([a.bundle,path(doc.fullName()),doc.name(),sheet?sheet.name():null]);
    let structure=kind==='word'?String(doc.textObject.endOfContent()):kind==='excel'?sheet.name():JSON.stringify(doc.slides().map(function(s){return [s.slideID(),s.shapes.length];}));
    return {app:app,doc:doc,sheet:sheet,kind:kind,identity:identity,structure:structure};
}
function liveRead(a) {
    let context=liveContext(a),doc=context.doc,kind=context.kind,offset=a.offset||0,blocks=[],targets={},total=0,next=null,budget=0,truncated=false;
    if(!Number.isInteger(offset)||offset<0||offset>100000)fail('Invalid document offset');
    function add(target,label,key,text,value) {
        text=String(text==null?'':text);
        if(text.length>8000 || budget+text.length>40000){blocks.push({label:label,editable:false,reason:'Text budget exceeded; read a smaller range'});truncated=true;return;}
        let id='b'+blocks.length;
        targets[id]={target:target,key:key,text:text};
        blocks.push({id:id,label:label,text:text,value:value===undefined?null:String(value)});budget+=text.length;
    }
    if(kind==='word') {
        let paragraphs=doc.paragraphs();total=paragraphs.length;
        for(let i=offset;i<Math.min(total,offset+80);i++) {
            let target=paragraphs[i].textObject, text=target.content();
            text=text.replace(/\r\u0007$|\r$/,'');
            add(target,'paragraph '+(i+1),String(i),text);
        }
        if(offset+80<total)next=offset+80;
    } else if(kind==='powerpoint') {
        let index=a.slide===undefined?1:a.slide;
        if(!Number.isInteger(index)||index<1||index>Math.max(1,doc.slides.length))fail('Choose an existing slide');
        if(doc.slides.length) {
            let shapes=doc.slides[index-1].shapes();total=shapes.length;
            for(let i=offset;i<Math.min(total,offset+80);i++)if(shapes[i].hasTextFrame())add(shapes[i].textFrame.textRange,'slide '+index+' shape '+shapes[i].name(),index+':'+i,shapes[i].textFrame.textRange.content());
            if(offset+80<total)next=offset+80;
        }
    } else {
        let address=a.range||'A1:L20',r=range(context.sheet,address),rows=r.rows.length,cols=r.columns.length;
        total=rows*cols;if(total>240)fail('Read at most 240 cells per range');
        let formulas=r.formula(),values=r.value();
        if(!Array.isArray(formulas))formulas=[[formulas]];
        if(!Array.isArray(values))values=[[values]];
        for(let row=0;row<rows;row++)for(let col=0;col<cols;col++) {
            let target=r.rows[row].cells[col];
            add(target,context.sheet.name()+'!'+context.app.getAddress(target),String(row)+':'+col,formulas[row][col],values[row][col]);
        }
    }
    let result={application:kind,document:doc.name(),blocks:blocks,total:total,nextOffset:next,slideCount:kind==='powerpoint'?doc.slides.length:null,pageWidth:kind==='powerpoint'?doc.pageSetup.slideWidth():null,pageHeight:kind==='powerpoint'?doc.pageSetup.slideHeight():null,truncated:truncated||next!==null,live:true,verification:'Native document values, including unsaved edits. Visual layout is not verified.',identity:context.identity,structure:context.structure};
    return {context:context,targets:targets,result:result};
}
function localFormula(text) {
    if(text[0]!=='=')return;
    if(text.length>1000 || !/^=[A-Za-z0-9 .,$():+*/^%<>=&-]+$/.test(text))fail('Use a local numeric formula without external references');
    let functions=text.match(/[A-Za-z]+\s*\(/g)||[];
    functions.forEach(function(f){if(!/^(SUM|AVERAGE|MIN|MAX|COUNT|COUNTA|IF|ROUND|ROUNDUP|ROUNDDOWN|ABS|AND|OR|NOT)\s*\($/i.test(f))fail('Unsupported formula function');});
    if(/[A-Za-z]/.test(text.replace(/[A-Za-z]+\s*\(/g,'(').replace(/\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}/g,'0')))fail('Named formulas require manual control');
}
function liveDocument(op,a) {
    let input=op==='documentRead'?a:Object.assign({},a.readArgs,{bundle:a.bundle,windowTitle:a.windowTitle});
    let reading=liveRead(input),c=reading.context;
    if(op==='documentRead')return reading.result;
    if(!a.observed || a.observed.identity!==reading.result.identity || a.observed.structure!==reading.result.structure || JSON.stringify(a.observed.blocks)!==JSON.stringify(reading.result.blocks))fail('Document changed. Read it again before editing');
    function check() {if(liveContext(a).identity!==c.identity)fail('The selected document changed; read again');}
    if(op==='documentCompose')return liveCompose(a,reading,check);
    if(!Array.isArray(a.edits)||!a.edits.length||a.edits.length>100)fail('Supply 1 to 100 edits');
    let seen={},plan=a.edits.map(function(e) {
        let block=reading.targets[e.id];
        if(!block||seen[e.id]||typeof e.expected!=='string'||typeof e.before!=='string'||typeof e.after!=='string'||e.after.length>8000)fail('Use unique observed block IDs and bounded text');
        seen[e.id]=true;
        if(block.text!==e.expected)fail('The expected block differs');
        let at=e.expected.indexOf(e.before);
        if(e.before===''?e.expected!=='':at<0||at!==e.expected.lastIndexOf(e.before))fail('before must match exactly once');
        let result=e.expected.slice(0,at)+e.after+e.expected.slice(at+e.before.length);
        if(result.length>8000 || /\u0007/.test(result) || (c.kind==='word'&&/[\r\n]/.test(result)))fail('Do not replace document boundaries');
        if(c.kind==='excel')localFormula(result);
        return {edit:e,block:block,at:at,result:result};
    });
    let completed=[],error=null,failed=null;
    try {
        plan.forEach(function(p) {
            check();failed=p.edit.id;
            let t=p.block.target,current=c.kind==='excel'?String(t.formula()):String(t.content()).replace(c.kind==='word'?/\r\u0007$|\r$/:/$^/,'');
            if(current!==p.edit.expected)fail('A block changed after preflight');
            if(c.kind==='excel')t.formula=p.result[0]==='='?p.result.toUpperCase():"'"+p.result;
            else if(c.kind==='word')c.app.createRange(c.doc,{start:t.startOfContent()+p.at,end:t.startOfContent()+p.at+p.edit.before.length}).content=p.edit.after;
            else if(!p.edit.before)t.content=p.edit.after;
            else t.characters.slice(p.at,p.at+p.edit.before.length).content=p.edit.after;
            check();
            let actual=c.kind==='excel'?String(t.formula()):String(t.content()).replace(c.kind==='word'?/\r\u0007$|\r$/:/$^/,'');
            if(actual!==(c.kind==='excel'&&p.result[0]==='='?p.result.toUpperCase():p.result))fail('Native readback differs; read again, do not replay');
            completed.push({id:p.edit.id,text:actual,value:c.kind==='excel'?String(t.value()):null});
        });failed=null;
    }catch(e){error=String(e.message||e);}
    return {live:true,completed:completed,completeReadback:error===null,error:error,failedBlock:failed,reobserveRequired:error!==null,saved:false,verification:'Only returned native block values were verified. No file save was requested; app AutoSave may still apply. Verify layout independently.'};
}
function validateComposition(a,kind,page) {
    let modes=['slides','paragraphs','format'].filter(function(k){return a[k]!==undefined;});
    if(modes.length!==1)fail('Choose one composition payload');
    let mode=modes[0];
    if({slides:'powerpoint',paragraphs:'word',format:'excel'}[mode]!==kind)fail('Composition does not match this application');
    function fields(o,allowed){if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(function(k){return allowed.indexOf(k)<0;}))fail('Unsupported composition field');}
    function number(o,k,min,max){if(typeof o[k]!=='number'||!isFinite(o[k])||o[k]<min||o[k]>max)fail('Invalid '+k);}
    function items(v,max){if(!Array.isArray(v)||!v.length||v.length>max)fail('Invalid composition batch size');return v;}
    function style(o){
        ['color','fill','background'].forEach(function(k){if(o[k]!==undefined && (typeof o[k]!=='string'||!/^#?[a-fA-F0-9]{6}$/.test(o[k])))fail('Use six-digit RGB colors');});
        ['bold','autoFit'].forEach(function(k){if(o[k]!==undefined&&typeof o[k]!=='boolean')fail('Invalid boolean style');});
        if(o.fontSize!==undefined)number(o,'fontSize',8,120);
        if(o.text!==undefined && (typeof o.text!=='string'||o.text.length>8000||/[\x00-\x08\x0b-\x1f]/.test(o.text)))fail('Invalid document text');
    }
    if(mode==='slides')items(a.slides,12).forEach(function(s){
        fields(s,['slide','background','boxes']);style(s);
        if(s.slide!==undefined&&(!Number.isInteger(s.slide)||s.slide<1||s.slide>page.slideCount))fail('Choose an existing slide or omit slide to append');
        items(s.boxes,40).forEach(function(b){fields(b,['text','x','y','width','height','fontSize','color','bold','fill']);style(b);
            if(typeof b.text!=='string'||typeof b.color!=='string')fail('Text and color are required');
            number(b,'fontSize',8,120);number(b,'x',0,4000);number(b,'y',0,4000);number(b,'width',0.01,4000);number(b,'height',0.01,4000);
            if(b.x+b.width>page.pageWidth || b.y+b.height>page.pageHeight)fail('A text box extends outside the slide');
        });
    });
    else if(mode==='paragraphs')items(a.paragraphs,80).forEach(function(p){fields(p,['text','fontSize','color','bold']);style(p);if(typeof p.text!=='string')fail('Paragraph text is required');});
    else {fields(a.format,['fontSize','color','bold','numberFormat','autoFit']);style(a.format);if(!Object.keys(a.format).length)fail('Empty format');if(a.format.numberFormat!==undefined&&['General','#,##0','#,##0.00','0%','0.00%'].indexOf(a.format.numberFormat)<0)fail('Unsupported number format');}
    return mode;
}
function liveCompose(a,reading,check) {
    let c=reading.context,mode=validateComposition(a,c.kind,reading.result),completed=[],error=null;
    function font(target,s,ppt){if(s.fontSize!==undefined)target.fontSize=s.fontSize;if(s.bold!==undefined)target.bold=s.bold;if(s.color!==undefined){if(ppt)target.fontColor=rgb(s.color);else target.color=rgb(s.color);}}
    try {
        if(mode==='format') {
            check();let r=range(c.sheet,a.readArgs.range||'A1:L20');font(r.fontObject,a.format,false);
            if(a.format.numberFormat!==undefined)r.numberFormat=a.format.numberFormat;
            if(a.format.autoFit)c.app.autofit(r.entireColumn);
            completed.push({range:a.readArgs.range||'A1:L20',numberFormat:r.numberFormat(),fontSize:String(r.fontObject.fontSize()),bold:String(r.fontObject.bold()),columnWidth:String(r.columnWidth())});
        } else if(mode==='paragraphs')a.paragraphs.forEach(function(p){
            check();let start=c.doc.textObject.endOfContent()-1;
            if(start>0&&c.app.createRange(c.doc,{start:start-1,end:start}).content()!=='\r'){c.app.createRange(c.doc,{start:start,end:start}).content='\r';start++;}
            let value=p.text.replace(/\n/g,'\r')+'\r';c.app.createRange(c.doc,{start:start,end:start}).content=value;
            let r=c.app.createRange(c.doc,{start:start,end:start+value.length});font(r.fontObject,p,false);check();
            if(r.content()!==value)fail('Paragraph readback differs; do not replay');completed.push({start:start,text:value});
        });
        else a.slides.forEach(function(s){
            check();let slide=s.slide?c.doc.slides[s.slide-1]:c.app.make({new:'slide',at:c.doc,withProperties:{layout:'slide layout blank'}});
            if(s.background!==undefined){slide.followMasterBackground=false;slide.background.fillFormat.foreColor=rgb(s.background);}
            s.boxes.forEach(function(b){
                check();let shape=c.app.make({new:'text box',at:slide,withProperties:{leftPosition:b.x,top:b.y,width:b.width,height:b.height}});
                let f=shape.textFrame;f.marginLeft=0;f.marginRight=0;f.marginTop=0;f.marginBottom=0;f.wordWrap=true;
                f.textRange.content=b.text;font(f.textRange.font,b,true);
                if(b.fill!==undefined){shape.fillFormat.visible=true;shape.fillFormat.foreColor=rgb(b.fill);}
                check();let actual=f.textRange.content();if(actual.replace(/\r/g,'\n')!==b.text.replace(/\r/g,'\n'))fail('Text readback differs; do not replay');
                completed.push({slide:slide.slideIndex(),shape:shape.name(),text:actual});
            });
        });
    }catch(e){error=String(e.message||e)+' A partial object may remain; inspect before continuing.';}
    return {completed:completed,error:error,live:true,reobserveRequired:true,saved:false,verification:'Returned native values only. Verify visual layout, formatting and task completeness independently.'};
}
