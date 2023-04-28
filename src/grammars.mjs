
import deepcopy  from "deepcopy"
import fsp       from "fs/promises"
import path      from "path"
import url       from 'url';
import vsctm     from "vscode-textmate"
import oniguruma from "vscode-oniguruma"
import yaml      from "yaml"

import { Config }       from "./configuration.mjs"
import { ScopeActions } from "./scopeActions.mjs"

const True  = 1
const False = 0

// Some of the javascript in this module has been adapted from the example:
//   https://github.com/microsoft/vscode-textmate#using

class Grammars {
  static scope2grammar         = {}
  static originalScope2grammar = {}

  static _wasmBin
  static _vscodeOnigurumaLib
  static _registry

  static async _initGrammarsClass() {
      
    Grammars._wasmBin = await fsp.readFile(
      path.join(
        path.dirname(url.fileURLToPath(import.meta.url)),
       '../node_modules/vscode-oniguruma/release/onig.wasm'
      )
    )

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
        console.log(`Unknown scope name: ${scopeName}`);
        return null;
      }
    });
  }

  static chooseBaseScope(aDocPath, aFirstLine) {
    // start by checking first line matches...
    for (const [aBaseScope, aGrammar] of Object.entries(Grammars.scope2grammar)) {
      if (aGrammar['firstLineMatch']) {
        //console.log(`Checking firstLineMatch for ${aBaseScope}`)
        if (aFirstLine.match(aGrammar['firstLineMatch'])) return aBaseScope
      }
    }
    // since none of the first line matches found a match...
    // ... move on to checking the file extension
    for (const [aBaseScope, aGrammar] of Object.entries(Grammars.scope2grammar)) {
      if (aGrammar['fileTypes']) {
        for (const [anIndex, aFileExt] of aGrammar['fileTypes'].entries()) {
          //console.log(`Checking ${aBaseScope} file type (${aFileExt}) against [${aDocPath}]`)
          if (aDocPath.endsWith(aFileExt)) return aBaseScope
        }
      }
    }
    console.log("chooseBaseScope: no match found!")
  }

  static async testGrammarsUsing(aDoc) {
    const aBaseScope = Grammars.chooseBaseScope(aDoc.filePath, aDoc.docLines[0])
    if (!aBaseScope) {
      console.log("WARNING: Could not find the base scope for the document")
      console.log(`  ${aDoc.docName}`)
      return
    }
    const aGrammar = await Grammars.registry.loadGrammar(aBaseScope)
    let ruleStack = vsctm.INITIAL
    aDoc.docLines.forEach(function(aLine){
      const lineTokens = aGrammar.tokenizeLine(aLine, ruleStack)
      console.log(`\nTokenizing line: >>${aLine}<< (${aLine.length})`);
      lineTokens.tokens.forEach(function(aToken){
        console.log(` - token from ${aToken.startIndex} to ${aToken.endIndex} ` +
          `(${aLine.substring(aToken.startIndex, aToken.endIndex)}) ` +
          `with scopes:`
        );
        aToken.scopes.forEach(function(aScope){
          console.log(`     ${aScope}`)
      })
      })
      ruleStack = lineTokens.ruleStack;
    })
  }
  /*
  function testGrammar(testFile) {
    const text = testFile.toString().split('\n');
    var scopeFound = False ;
    for (const [aScope, aGrammar] of Object.entries(scope2grammar)) {
      if (text[0].match(aGrammar['regex'])) {
        scopeFound = True;
        // Load the JavaScript grammar and any other grammars included by it async.
        registry.loadGrammar(aScope).then(grammar => {
          let ruleStack = vsctm.INITIAL;
          for (let i = 0; i < text.length; i++) {
            const line = text[i];
            const lineTokens = grammar.tokenizeLine(line, ruleStack);
            console.log(`\nTokenizing line: >>${line}<< (${line.length})`);
            for (let j = 0; j < lineTokens.tokens.length; j++) {
              const token = lineTokens.tokens[j];
              console.log(` - token from ${token.startIndex} to ${token.endIndex} ` +
                `(${line.substring(token.startIndex, token.endIndex)}) ` +
                `with scopes:`
              );
              token.scopes.forEach(
                aScope => console.log(`     ${aScope}`)
              );
            }
            ruleStack = lineTokens.ruleStack;
          }
        });
      }
    }
  
    if (! scopeFound) console.log("No matching grammar found!")
  }
*/  

  static async loadGrammarFrom(aGrammarPath, verbose) {
    var aGrammar = {}
    if (aGrammarPath.endsWith('.json')) {
      if (verbose) console.log(`loading grammar from ${aGrammarPath}`)
      aGrammarPath = Config.normalizePath(aGrammarPath)
      const aGrammarStr = await fsp.readFile(aGrammarPath, "utf8")
      aGrammar = JSON.parse(aGrammarStr)
    } else {
      console.log("At the moment we can ONLY load JSON Grammars!")
      return
    }
    if (aGrammar['scopeName']) {
      const baseScope = aGrammar['scopeName']
      if (Grammars.originalScope2grammar[baseScope]) {
        console.log(`WARNING: you are over-writing an existing ${baseScope} grammar`)
      }
      Grammars.originalScope2grammar[baseScope] = aGrammar
    }
    for (const [aScope, aGrammar] of Object.entries(Grammars.originalScope2grammar)) {
      Grammars.scope2grammar[aScope] = deepcopy(aGrammar)
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  // (recursively) prune all known grammars

  static pruneGrammars(verbose) {
    if (verbose) console.log("--PRUNING-GRAMMARS------------------------------")
    const s2g = Grammars.scope2grammar = {}
    for (const [aScope, aGrammar] of Object.entries(Grammars.originalScope2grammar)){
      s2g[aScope] = deepcopy(aGrammar)
    }
    
    const knownBaseScopes = {} // prevent infinite loops of grammars checking
    const scopes2keep     = {} // map of scopes with actions
    ScopeActions.forEach(function(aScope, anAction){
      scopes2keep[aScope] = True
    })
    function keepScope(aScope) {
      if (!aScope) return False
      if (scopes2keep[aScope]) return True
      if (verbose) console.log(`don't keep scope ${aScope}`)
      return False
    }
    function keepCapture(someCaptures) {
      if (!someCaptures) return False
      for (const [aCaptureNum, aCapture] of Object.entries(someCaptures)){
        if (scopes2keep[aCapture['name']]) return True
      }
      if (verbose) console.log(`don't keep captures: ${yaml.stringify(someCaptures)}`)
      return False
    }
    function keepPatterns(somePatterns, patterns2keep, gRepo) {
      if (!somePatterns) return False
      const pats2delete = []
      var anIndex = -1
      somePatterns.forEach(function(aPattern){
        anIndex += 1
        if (!keepRule(aPattern, patterns2keep, gRepo)) {
          pats2delete.unshift(anIndex)
        }
      })
      if (verbose) console.log(`deleting patterns ${pats2delete}`)
      pats2delete.forEach(function(anIndex){
        somePatterns.splice(anIndex,1)
      })
      return (0 < somePatterns.length)
    }
    function keepRule(aRule, patterns2keep, gRepo) {
      if (!aRule)                                                return False
      if (keepScope(aRule['name']))                              return True
      if (keepScope(aRule['contentName']))                       return True
      if (keepCapture(aRule['captures']))                        return True
      if (keepCapture(aRule['beginCaptures']))                   return True
      if (keepCapture(aRule['endCaptures']))                     return True
      if (keepPatterns(aRule['patterns'], patterns2keep, gRepo)) return True
      if (keepInclude(aRule['include'],   patterns2keep, gRepo)) {
        patterns2keep[aRule['include']] = True
                                                                 return True
      } 
      if (verbose) console.log(`don't keep rule: ${yaml.stringify(aRule)}`)
                                                                 return False
    }
    function keepInclude(anInclude, patterns2keep, gRepo) {
      if (!anInclude) return False
      if (anInclude.startsWith('$')) {
        console.log("WARNING: Using $self or $base in a grammar is not wise!")
                                                    return False
      }
      if (anInclude.startsWith('#')) {
        if (patterns2keep[anInclude])               return True
        if (keepRule(gRepo[anInclude.slice(1)], patterns2keep, gRepo)) {
                                                    return True
        }
                                                    return False
      }
      if (scopes2keep[anInclude])                   return True
      if (s2g[anInclude]) {
        if (keepGrammar(anInclude, s2g[anInclude])) return True
                                                    return False
      }
    }
    function keepGrammar(aBaseScope, aGrammar){
      if (knownBaseScopes[aBaseScope]) return scopes2keep[aBaseScope] //CHECK ME!!!!
      knownBaseScopes[aBaseScope] = True
      if (scopes2keep[aBaseScope]) return True
      if (!aGrammar['patterns'])   return False
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
    if (verbose) console.log("------------------------------------------------")
  }

  static printGrammar(aBaseScope) {
    if (!Grammars.scope2grammar[aBaseScope]) return
    console.log("--grammar----------------------------------------------------")
    console.log(aBaseScope)
    console.log("---------------")
    console.log(yaml.stringify(Grammars.scope2grammar[aBaseScope]))
  }

  static printAllGrammars() {
    Object.keys(Grammars.scope2grammar).sort().forEach(function(aBaseScope){
      Grammars.printGrammar(aBaseScope)
    })
    console.log("-------------------------------------------------------------")
  }
}

await Grammars._initGrammarsClass()

export { Grammars }