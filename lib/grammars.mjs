
import deepcopy  from "deepcopy"
import fsp       from "fs/promises"
import path      from "path"
import url       from 'url';
import vsctm     from "vscode-textmate"
import oniguruma from "vscode-oniguruma"
import yaml      from "yaml"

import { Config        } from "./configuration.mjs"
import { DocumentCache } from "./documents.mjs"
import { ScopeActions  } from "./scopeActions.mjs"
import { Structures    } from "./structures.mjs"
import { Logging    } from "./logging.mjs"

const logger = Logging.getLogger('rootLogger')

// Some of the javascript in this module has been adapted from the example:
//   https://github.com/microsoft/vscode-textmate#using

//TODO: https://masteringjs.io/tutorials/fundamentals/async-foreach

class Grammars {
  static scope2grammar         = {}
  static originalScope2grammar = {}
  static loadedGrammars        = {}

  static _wasmBin
  static _vscodeOnigurumaLib
  static _registry

  static async _initGrammarsClass() {
    
    try {
      // try to find onig.wasm assuming we are in the development setup
      Grammars._wasmBin = await fsp.readFile(
        path.join(
          path.dirname(url.fileURLToPath(import.meta.url)),
          '../node_modules/vscode-oniguruma/release/onig.wasm'
        )
      )
    } catch (err) {
      try {
        // try to find onig.wasm assuming we are in the npm installed setup
        logger.trace("Trying to load onig.wasm from npm")
        Grammars._wasmBin = await fsp.readFile(
          path.join(
            path.dirname(url.fileURLToPath(import.meta.url)),
            '../../vscode-oniguruma/release/onig.wasm'
          )
        )
      } catch (error) {
        logger.fatal("Could not load the oniguruma WASM file...")
        process.exit(1)
      }
    }
          
    Grammars._vscodeOnigurumaLib = oniguruma.loadWASM(Grammars._wasmBin)
    .then(function() {
      return {
        createOnigScanner(patterns) { return new oniguruma.OnigScanner(patterns); },
        createOnigString(s) { return new oniguruma.OnigString(s); }
      };
    });

    // Create a registry that can create a grammar from a scope name.
    Grammars.registry = new vsctm.Registry({
      onigLib: Grammars._vscodeOnigurumaLib,
      loadGrammar: (scopeName) => {
        if (scopeName in Grammars.scope2grammar ) {
          return Grammars.scope2grammar[scopeName]
        }
        logger.warn(`Unknown scope name: ${scopeName}`);
        return null;
      }
    });
  }

  static chooseBaseScope(aDocPath, aFirstLine) {
    // start by checking first line matches...
    for (const [aBaseScope, aGrammar] of Object.entries(Grammars.scope2grammar)) {
      if (aGrammar['firstLineMatch']) {
        logger.trace(`Checking firstLineMatch for ${aBaseScope}`)
        if (aFirstLine.match(aGrammar['firstLineMatch'])) return aBaseScope
      }
    }
    // since none of the first line matches found a match...
    // ... move on to checking the file extension
    for (const [aBaseScope, aGrammar] of Object.entries(Grammars.scope2grammar)) {
      if (aGrammar['fileTypes']) {
        for (const [anIndex, aFileExt] of aGrammar['fileTypes'].entries()) {
          logger.trace(`Checking ${aBaseScope} file type (${aFileExt}) against [${aDocPath}]`)
          if (aDocPath.endsWith(aFileExt)) return aBaseScope
        }
      }
    }
    logger.warn("chooseBaseScope: no match found!")
  }

  static async traceParseOf(aDocPath, config) {
    var traceObj
    var traceOutput
    if (config['trace']) {
      traceOutput = true
      traceObj = function (traceOpts, aStr) {
        if (0 < traceOpts['exclude'].length) {
          for (const aRegExp of traceOpts['exclude'].values() ) {
            if (aStr.match(aRegExp)) {
              logger.debug(`[${aStr}] EXCLUDED by [${aRegExp}]`)
              return false
            }
          }
        }
        if (0 < traceOpts['include'].length) {
          for (const aRegExp of traceOpts['include'].values() ) {
            if (aStr.match(aRegExp)) {
              logger.debug(`[${aStr}] INCLUDED by [${aRegExp}]`)
              return true
            }
          }
          logger.debug("No match found in traceObj")
          return false
        }
        return true
      }
    } else {
      traceOutput = false
      traceObj = function (traceOpts, aStr) {
        return false
      }
    }
    
    const aDoc = await DocumentCache.loadFromFile(aDocPath)
    const aBaseScope = Grammars.chooseBaseScope(aDoc.filePath, aDoc.docLines[0])
    if (!aBaseScope) {
      logger.warn("WARNING: Could not find the base scope for the document")
      logger.warn(`  ${aDoc.docName}`)
      return
    }
    logger.trace("\n--TRACING--------------------------------------------------------")
    logger.trace(`${aDocPath} (using ${aBaseScope})`)
    logger.trace("-----------------------------------------------------------------")
    const scopesWithActions = ScopeActions.getScopesWithActions()
    const structureNames    = Structures.getStructureNames()
    const aGrammar          = await Grammars.registry.loadGrammar(aBaseScope)
    let ruleStack           = vsctm.INITIAL
    var   lineNum           = -1
    for (const aLine of aDoc.docLines) {
      lineNum += 1
      const scopes2run = {}
      const lineTokens = aGrammar.tokenizeLine(aLine, ruleStack)
      const showLine   = traceObj(config['traceLines'], aLine)
      if (showLine) {
        logger.debug(`\nTokenizing line[${lineNum}]: >>${aLine}<< (${aLine.length})`);
      }
      for (const aToken of lineTokens.tokens) {
        if (showLine) {
          logger.debug(` - token from ${aToken.startIndex} to ${aToken.endIndex} ` +
            `(${aLine.substring(aToken.startIndex, aToken.endIndex)}) ` +
            `with scopes:`
          );
        }
        for (const aScope of aToken.scopes) {
          const showScope  = traceObj(config['traceScopes'], aScope)
          if (showLine && showScope) logger.debug(`     ${aScope}`)
          if (scopesWithActions[aScope]) {
            if (!scopes2run[aScope]) scopes2run[aScope] = []
              scopes2run[aScope].push(
                aLine.substring(aToken.startIndex, aToken.endIndex)
              )
            }
        }
      }
      if (scopes2run) {
        for (const [aScope, someTokens] of Object.entries(scopes2run)) {
          const showScope  = traceObj(config['traceScopes'], aScope)
          const showAction = traceObj(config['traceActions'], aScope)
          if (showLine && showScope && showAction) {
            logger.debug(">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>")
            if (showLine && showScope) {
              logger.debug(`${aScope} :`)
              logger.debug(yaml.stringify(someTokens))
            }
          }
          for (const anAction of scopesWithActions[aScope]) {
            await anAction.run(aScope, someTokens, lineNum, aDoc, traceOutput)
          }
          if (showLine && showScope && showAction) {
            for (const aStructureName of structureNames) {
              if (traceObj(config['traceStructures'], aStructureName)) {
                  Structures.logStructure(aStructureName)
                }
              }
            logger.debug("<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<")
          }
        }
      }
      ruleStack = lineTokens.ruleStack;
    }
  }

  static async loadGrammarFrom(aGrammarPath, verbose) {
    var aGrammar = {}
    
    if (aGrammarPath.endsWith('.json')) {
      if (Grammars.loadedGrammars[aGrammarPath]) {
        logger.trace(`Warning you have already loaded ${aGrammarPath}`)
        return
      }
      aGrammarPath = Config.normalizePath(aGrammarPath)
      if (Grammars.loadedGrammars[aGrammarPath]) {
        logger.trace(`Warning you have already loaded ${aGrammarPath}`)
        return
      }
      
      Grammars.loadedGrammars[aGrammarPath] = true
      logger.debug(`loading grammar from ${aGrammarPath}`)
      const aGrammarStr = await fsp.readFile(aGrammarPath, "utf8")
      aGrammar = JSON.parse(aGrammarStr)
    } else {
      logger.warn("At the moment we can ONLY load JSON Grammars!")
      return
    }
    if (aGrammar['scopeName']) {
      const baseScope = aGrammar['scopeName']
      if (Grammars.originalScope2grammar[baseScope]) {
        logger.warn(`WARNING: you are over-writing an existing ${baseScope} grammar`)
      }
      Grammars.originalScope2grammar[baseScope] = aGrammar
    }
    for (const [aScope, aGrammar] of Object.entries(Grammars.originalScope2grammar)) {
      Grammars.scope2grammar[aScope] = deepcopy(aGrammar)
    }
  }

  static getKnownScopes() {
    const knownScopes = {}
    function addScopesFromPatterns(somePatterns) {
      if (!somePatterns) return
      for (const aPattern of somePatterns) { addScopesFromRule(aPattern) }
    }
    function addScopesFromRepository(aRepository) {
      if (!aRepository) return
      for (const [aKey, aValue] of Object.entries(aRepository)) {
        addScopesFromRule(aValue)
      }
    }
    function addScopesFromCaptures(someCaptures) {
      if (!someCaptures) return
      for (const [aKey, aValue] of Object.entries(someCaptures)) {
        addScopesFromRule(aValue)
      }
    }
    function addScopesFromRule(aRule) {
      if (!aRule) return
      if (aRule['name'])        knownScopes[aRule['name']]        = true
      if (aRule['scopeName'])   knownScopes[aRule['scopeName']]   = true
      if (aRule['contentName']) knownScopes[aRule['contentName']] = true
      addScopesFromPatterns(aRule['patterns'])
      addScopesFromRepository(aRule['repository'])
      addScopesFromCaptures(aRule['captures'])
      addScopesFromCaptures(aRule['beginCaptures'])
      addScopesFromCaptures(aRule['endCaptures'])
    }
    for (const [aScope, aGrammar] of Object.entries(Grammars.scope2grammar)){
      knownScopes[aScope] = true
      addScopesFromPatterns(aGrammar['patterns'])
      addScopesFromRepository(aGrammar['repository'])
    }
    return Object.keys(knownScopes).sort()
  }

  //////////////////////////////////////////////////////////////////////////////
  // (recursively) prune all known grammars

  static pruneGrammars(scopes2keep, verbose) {
    logger.debug("--PRUNING-GRAMMARS------------------------------")
    const s2g = Grammars.scope2grammar = {}
    for (const [aScope, aGrammar] of Object.entries(Grammars.originalScope2grammar)){
      s2g[aScope] = deepcopy(aGrammar)
    }
    
    const knownBaseScopes = {} // prevent infinite loops of grammars checking

    function keepScope(aScope) {
      if (!aScope) return false
      if (scopes2keep[aScope]) return true
      logger.debug(`don't keep scope ${aScope}`)
      return false
    }
    function keepCapture(someCaptures) {
      if (!someCaptures) return false
      for (const [aCaptureNum, aCapture] of Object.entries(someCaptures)){
        if (scopes2keep[aCapture['name']]) return true
      }
      logger.debug(`don't keep captures: ${yaml.stringify(someCaptures)}`)
      return false
    }
    function keepPatterns(somePatterns, patterns2keep, gRepo) {
      if (!somePatterns) return false
      const pats2delete = []
      var anIndex = -1
      for (const aPattern of somePatterns) {
        anIndex += 1
        if (!keepRule(aPattern, patterns2keep, gRepo)) {
          pats2delete.unshift(anIndex)
        }
      }
      logger.debug(`deleting patterns ${pats2delete}`)
      for (const anIndex of pats2delete) {
        somePatterns.splice(anIndex,1)
      }
      return (0 < somePatterns.length)
    }
    function keepRule(aRule, patterns2keep, gRepo) {
      if (!aRule)                                                return false
      if (keepScope(aRule['name']))                              return true
      if (keepScope(aRule['contentName']))                       return true
      if (keepCapture(aRule['captures']))                        return true
      if (keepCapture(aRule['beginCaptures']))                   return true
      if (keepCapture(aRule['endCaptures']))                     return true
      if (keepPatterns(aRule['patterns'], patterns2keep, gRepo)) return true
      if (keepInclude(aRule['include'],   patterns2keep, gRepo)) {
        patterns2keep[aRule['include']] = true
                                                                 return true
      } 
      logger.debug(`don't keep rule: ${yaml.stringify(aRule)}`)
                                                                 return false
    }
    function keepInclude(anInclude, patterns2keep, gRepo) {
      if (!anInclude) return false
      if (anInclude.startsWith('$')) {
        logger.warn("WARNING: Using $self or $base in a grammar is not wise!")
                                                    return false
      }
      if (anInclude.startsWith('#')) {
        if (patterns2keep[anInclude])               return true
        if (keepRule(gRepo[anInclude.slice(1)], patterns2keep, gRepo)) {
                                                    return true
        }
                                                    return false
      }
      if (scopes2keep[anInclude])                   return true
      if (s2g[anInclude]) {
        if (keepGrammar(anInclude, s2g[anInclude])) return true
                                                    return false
      }
    }
    function keepGrammar(aBaseScope, aGrammar){
      if (knownBaseScopes[aBaseScope]) return scopes2keep[aBaseScope] //CHECK ME!!!!
      knownBaseScopes[aBaseScope] = true
      if (scopes2keep[aBaseScope]) return true
      if (!aGrammar['patterns'])   return false
      const patterns2keep   = {}
      var   gRepo           = {}
      if (aGrammar['repository']) gRepo = aGrammar['repository']
      const keepThePatterns = keepPatterns(
        aGrammar['patterns'], patterns2keep, gRepo
      )
      for (const [aRepoKey, aRule] of Object.entries(gRepo)) {
        if (!patterns2keep['#'+aRepoKey]) delete gRepo[aRepoKey]
      }
      scopes2keep[aBaseScope] = keepThePatterns
      return keepThePatterns
    }
    for (const [aBaseScope, aGrammar] of Object.entries(s2g)) {
      keepGrammar(aBaseScope, aGrammar)
    }
    logger.debug("------------------------------------------------")
  }

  //////////////////////////////////////////////////////////////////////////////

  static printGrammar(aBaseScope) {
    if (!Grammars.scope2grammar[aBaseScope]) return
    console.log("--grammar----------------------------------------------------")
    console.log(aBaseScope)
    console.log("---------------")
    console.log(yaml.stringify(Grammars.scope2grammar[aBaseScope]))
  }

  static printAllGrammars() {
    for (const aBaseScope of Object.keys(Grammars.scope2grammar).sort()) {
      Grammars.printGrammar(aBaseScope)
    }
    console.log("-------------------------------------------------------------")
  }
}

await Grammars._initGrammarsClass()

export { Grammars }