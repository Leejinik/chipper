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

