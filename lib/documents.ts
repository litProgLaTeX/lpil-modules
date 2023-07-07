/**
 * Document cache
 * 
 * We implement a simple Documents Cache...
 * 
 * @module
 */

import * as fsp  from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"

import { Cfgr                 } from "./configurator.js"
import { Logging, ValidLogger } from "./logging.js"

const logger : ValidLogger = Logging.getLogger('lpic')

// A representation of a single document
export class Document {
  // The file-system path to the document
  filePath : string = ""

  // The document cache name of the document
  docName  : string = ""

  // The contents of the document 
  docLines : Array<string> = []

  /**
   * Does nothing at the moment...
   */
  constructor() {
    // do nothing at the moment
  }

  /**
   * Refresh this document from a document string
   * 
   * @param aDocName - TODO This is WRONG we should not change the name of this document here!
   * @param aDocStr - A string version of the document's current value
   */
  refreshFromStr(aDocName: string, aDocStr : string) {
    this.docName = aDocName
    this.docLines = aDocStr.split('\n')
  }

  /**
   * Load a document from a file in the file-system
   * 
   * TODO: we should NOT use the current <refreshFromString>
   * 
   * @param aPath - A path to the file
   */
  async loadFromFile(aPath: string) {
    logger.debug(`loading document from ${aPath}`)
    this.filePath = Cfgr.normalizePath(aPath)
    const aDocStr = await fsp.readFile(this.filePath, "utf8")
    this.refreshFromStr(aPath, aDocStr)
  }
}

// A cache of documents
export class DocumentCache {

  // A mapping of documents names to cached <Documents.Document>
  static documents : Map<string, Document> = new Map()

  // Does nothing... do not use
  constructor () {}

  /**
   * @param aPath - the name of the document to find in the cache
   * @returns true if the given path exists in the document cache
   */
  static hasDocument(aPath: string) {
    return DocumentCache.documents.has(aPath)
  }

  /** 
   * @param aPath - the name of the document to find in the cache
   * @returns the Document associated with the document name OR undefined if
   * there is no document with the given name
   */
  static getDocument(aPath: string) {
    return DocumentCache.documents.get(aPath)
  }

  /**
   * **asynchoronously** loads the document from a file in the file-system
   *
   * @param aPath - the path to the document to load
   * @returns A Promise which when fulfilled, returns the loaded Document or
   * undefined if the document could not be loaded.
   */
  static async loadFromFile(aPath:string) {
    const doc = new Document()
    await doc.loadFromFile(aPath)
    DocumentCache.documents.set(aPath, doc)
    return doc
  }

  /**
   * Loads the document from a string
   * 
   * @param docName - a name for the document in the cache
   * @param docStr - the document as a simple string
   * @returns the document
   */
  static loadFromStr(docName:string, docStr:string) {
    const doc = new Document()
    doc.refreshFromStr(docName, docStr)
    DocumentCache.documents.set(docName, doc)
    return doc
  }

}
