export namespace linefilter {
	
	export class FindResult {
	    rows: number[];
	    total: number;
	    capped?: boolean;
	    searched: number;
	    partial?: boolean;
	    canceled?: boolean;
	    issue?: string;
	    version: number;
	    changed?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FindResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rows = source["rows"];
	        this.total = source["total"];
	        this.capped = source["capped"];
	        this.searched = source["searched"];
	        this.partial = source["partial"];
	        this.canceled = source["canceled"];
	        this.issue = source["issue"];
	        this.version = source["version"];
	        this.changed = source["changed"];
	    }
	}
	export class Progress {
	    jobId: string;
	    phase: string;
	    scannedBytes: number;
	    totalBytes: number;
	    scannedLines: number;
	    hits: number;
	    ruleHits: number[];
	    encoding: string;
	    compressed?: string;
	    invalidBytes: number;
	    invalidLine: number;
	    done: boolean;
	    truncated: boolean;
	    canceled: boolean;
	    changed: boolean;
	    error?: string;
	    totalLines: number;
	    slowRules?: number[];
	    version: number;
	    tailLine: number;
	    elapsedMs: number;
	    firstHitMs: number;
	
	    static createFrom(source: any = {}) {
	        return new Progress(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.phase = source["phase"];
	        this.scannedBytes = source["scannedBytes"];
	        this.totalBytes = source["totalBytes"];
	        this.scannedLines = source["scannedLines"];
	        this.hits = source["hits"];
	        this.ruleHits = source["ruleHits"];
	        this.encoding = source["encoding"];
	        this.compressed = source["compressed"];
	        this.invalidBytes = source["invalidBytes"];
	        this.invalidLine = source["invalidLine"];
	        this.done = source["done"];
	        this.truncated = source["truncated"];
	        this.canceled = source["canceled"];
	        this.changed = source["changed"];
	        this.error = source["error"];
	        this.totalLines = source["totalLines"];
	        this.slowRules = source["slowRules"];
	        this.version = source["version"];
	        this.tailLine = source["tailLine"];
	        this.elapsedMs = source["elapsedMs"];
	        this.firstHitMs = source["firstHitMs"];
	    }
	}
	export class Row {
	    line: number;
	    text: string;
	    hit?: boolean;
	    rules?: number[];
	    col: number;
	    truncatedLine?: boolean;
	    skip?: number;
	    from?: number;
	
	    static createFrom(source: any = {}) {
	        return new Row(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.line = source["line"];
	        this.text = source["text"];
	        this.hit = source["hit"];
	        this.rules = source["rules"];
	        this.col = source["col"];
	        this.truncatedLine = source["truncatedLine"];
	        this.skip = source["skip"];
	        this.from = source["from"];
	    }
	}
	export class Page {
	    jobId: string;
	    from: number;
	    rows: Row[];
	    available: number;
	    total: number;
	    end: boolean;
	    truncated?: string;
	    changed?: boolean;
	    version: number;
	    progress: Progress;
	
	    static createFrom(source: any = {}) {
	        return new Page(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.from = source["from"];
	        this.rows = this.convertValues(source["rows"], Row);
	        this.available = source["available"];
	        this.total = source["total"];
	        this.end = source["end"];
	        this.truncated = source["truncated"];
	        this.changed = source["changed"];
	        this.version = source["version"];
	        this.progress = this.convertValues(source["progress"], Progress);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Rule {
	    id?: string;
	    kind?: string;
	    pattern: string;
	    regex?: boolean;
	    caseSensitive: boolean;
	    on?: boolean;
	    filter?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Rule(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.kind = source["kind"];
	        this.pattern = source["pattern"];
	        this.regex = source["regex"];
	        this.caseSensitive = source["caseSensitive"];
	        this.on = source["on"];
	        this.filter = source["filter"];
	    }
	}
	export class Request {
	    path: string;
	    encoding?: string;
	    rules: Rule[];
	
	    static createFrom(source: any = {}) {
	        return new Request(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.encoding = source["encoding"];
	        this.rules = this.convertValues(source["rules"], Rule);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class RuleIssue {
	    index: number;
	    id?: string;
	    reason: string;
	
	    static createFrom(source: any = {}) {
	        return new RuleIssue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.id = source["id"];
	        this.reason = source["reason"];
	    }
	}
	export class StartResult {
	    jobId: string;
	    issues?: RuleIssue[];
	    cached: boolean;
	    progress: Progress;
	
	    static createFrom(source: any = {}) {
	        return new StartResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.issues = this.convertValues(source["issues"], RuleIssue);
	        this.cached = source["cached"];
	        this.progress = this.convertValues(source["progress"], Progress);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace main {
	
	export class AssocType {
	    ext: string;
	    label: string;
	
	    static createFrom(source: any = {}) {
	        return new AssocType(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ext = source["ext"];
	        this.label = source["label"];
	    }
	}
	export class BundleFile {
	    rel: string;
	    size: number;
	    compressed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BundleFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rel = source["rel"];
	        this.size = source["size"];
	        this.compressed = source["compressed"];
	    }
	}
	export class BundleServer {
	    name: string;
	    files: BundleFile[];
	    truncated: boolean;
	    unreadable: number;
	    notRead: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BundleServer(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.files = this.convertValues(source["files"], BundleFile);
	        this.truncated = source["truncated"];
	        this.unreadable = source["unreadable"];
	        this.notRead = source["notRead"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Bundle {
	    root: string;
	    servers: BundleServer[];
	    rootFiles: BundleFile[];
	    rootTruncated: boolean;
	    truncated: boolean;
	    fileLimit: number;
	    files: number;
	
	    static createFrom(source: any = {}) {
	        return new Bundle(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.servers = this.convertValues(source["servers"], BundleServer);
	        this.rootFiles = this.convertValues(source["rootFiles"], BundleFile);
	        this.rootTruncated = source["rootTruncated"];
	        this.truncated = source["truncated"];
	        this.fileLimit = source["fileLimit"];
	        this.files = source["files"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class ChipsResult {
	    typed: number;
	    total: number;
	    canceled: boolean;
	    aborted: boolean;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new ChipsResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.typed = source["typed"];
	        this.total = source["total"];
	        this.canceled = source["canceled"];
	        this.aborted = source["aborted"];
	        this.message = source["message"];
	    }
	}
	export class FileDoc {
	    path: string;
	    name: string;
	    content: string;
	    modTime: number;
	    size: number;
	    encoding: string;
	    binary: boolean;
	    canceled: boolean;
	    eol: string;
	    eolMixed: boolean;
	    bom: boolean;
	    unchanged: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileDoc(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.content = source["content"];
	        this.modTime = source["modTime"];
	        this.size = source["size"];
	        this.encoding = source["encoding"];
	        this.binary = source["binary"];
	        this.canceled = source["canceled"];
	        this.eol = source["eol"];
	        this.eolMixed = source["eolMixed"];
	        this.bom = source["bom"];
	        this.unchanged = source["unchanged"];
	    }
	}
	export class FileStat {
	    exists: boolean;
	    modTime: number;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new FileStat(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.exists = source["exists"];
	        this.modTime = source["modTime"];
	        this.size = source["size"];
	    }
	}
	export class SaveOptions {
	    encoding: string;
	    eol: string;
	    eolMixed: boolean;
	    noBom: boolean;
	    force: boolean;
	    allowTooBig: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SaveOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.encoding = source["encoding"];
	        this.eol = source["eol"];
	        this.eolMixed = source["eolMixed"];
	        this.noBom = source["noBom"];
	        this.force = source["force"];
	        this.allowTooBig = source["allowTooBig"];
	    }
	}
	export class SessionBackup {
	    name: string;
	    kind: string;
	    modTime: number;
	    tabs: number;
	    work: number;
	    note: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionBackup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.modTime = source["modTime"];
	        this.tabs = source["tabs"];
	        this.work = source["work"];
	        this.note = source["note"];
	    }
	}
	export class SessionLoad {
	    data: string;
	    notice: string;
	    detail: string;
	    blocked: boolean;
	    legacy?: SessionBackup;
	    backup?: SessionBackup;
	
	    static createFrom(source: any = {}) {
	        return new SessionLoad(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.data = source["data"];
	        this.notice = source["notice"];
	        this.detail = source["detail"];
	        this.blocked = source["blocked"];
	        this.legacy = this.convertValues(source["legacy"], SessionBackup);
	        this.backup = this.convertValues(source["backup"], SessionBackup);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TagsBackupInfo {
	    file: string;
	    kind: string;
	    time: string;
	    tags: number;
	    names: string[];
	    places: number;
	    problem: string;
	
	    static createFrom(source: any = {}) {
	        return new TagsBackupInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file = source["file"];
	        this.kind = source["kind"];
	        this.time = source["time"];
	        this.tags = source["tags"];
	        this.names = source["names"];
	        this.places = source["places"];
	        this.problem = source["problem"];
	    }
	}
	export class TagsExportResult {
	    path: string;
	    confirm: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TagsExportResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.confirm = source["confirm"];
	    }
	}
	export class TagsImportAssign {
	    dir: Record<string, Array<string>>;
	    file: Record<string, Array<string>>;
	    name: Record<string, Array<string>>;
	
	    static createFrom(source: any = {}) {
	        return new TagsImportAssign(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dir = source["dir"];
	        this.file = source["file"];
	        this.name = source["name"];
	    }
	}
	export class TagsImportTag {
	    name: string;
	    rules: any[];
	
	    static createFrom(source: any = {}) {
	        return new TagsImportTag(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.rules = source["rules"];
	    }
	}
	export class TagsImportFile {
	    path: string;
	    file: string;
	    error: string;
	    tags: TagsImportTag[];
	    problems: string[];
	    tagsJson: boolean;
	    assign?: TagsImportAssign;
	
	    static createFrom(source: any = {}) {
	        return new TagsImportFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.file = source["file"];
	        this.error = source["error"];
	        this.tags = this.convertValues(source["tags"], TagsImportTag);
	        this.problems = source["problems"];
	        this.tagsJson = source["tagsJson"];
	        this.assign = this.convertValues(source["assign"], TagsImportAssign);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TagsLoad {
	    data: string;
	    exists: boolean;
	    restored: boolean;
	    restoredFrom: string;
	    broken: string;
	    problem: string;
	    newer: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TagsLoad(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.data = source["data"];
	        this.exists = source["exists"];
	        this.restored = source["restored"];
	        this.restoredFrom = source["restoredFrom"];
	        this.broken = source["broken"];
	        this.problem = source["problem"];
	        this.newer = source["newer"];
	    }
	}

}

export namespace updater {
	
	export class UpdateInfo {
	    available: boolean;
	    currentVersion: string;
	    latestVersion: string;
	    releaseNotes: string;
	    downloadUrl: string;
	    publishedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.currentVersion = source["currentVersion"];
	        this.latestVersion = source["latestVersion"];
	        this.releaseNotes = source["releaseNotes"];
	        this.downloadUrl = source["downloadUrl"];
	        this.publishedAt = source["publishedAt"];
	    }
	}
	export class AutoUpdateResult {
	    applying: boolean;
	    blocked: boolean;
	    info: UpdateInfo;
	
	    static createFrom(source: any = {}) {
	        return new AutoUpdateResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.applying = source["applying"];
	        this.blocked = source["blocked"];
	        this.info = this.convertValues(source["info"], UpdateInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PendingNotes {
	    version: string;
	    notes: string;
	
	    static createFrom(source: any = {}) {
	        return new PendingNotes(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.notes = source["notes"];
	    }
	}

}

