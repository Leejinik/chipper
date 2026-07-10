export namespace main {
	
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

