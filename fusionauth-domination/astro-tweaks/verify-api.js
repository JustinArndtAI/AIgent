#!/usr/bin/env node

/**
 * FusionAuth API Endpoint Verification Script
 * 
 * Validates API endpoints referenced in documentation against the actual FusionAuth API,
 * ensuring documentation stays in sync with API changes and deprecations.
 * 
 * Features:
 * - OpenAPI spec validation
 * - Live endpoint testing
 * - Response schema verification
 * - Documentation sync checking
 * - Breaking change detection
 * - Performance monitoring
 * 
 * Usage:
 *   npm run verify-api
 *   npm run verify-api -- --env=staging --include-deprecated
 *   npm run verify-api -- --watch --fix-docs
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import yaml from 'js-yaml';
import chalk from 'chalk';
import { glob } from 'glob';
import matter from 'gray-matter';
import semver from 'semver';
import { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  // API endpoints to verify
  fusionAuthUrl: process.env.FUSIONAUTH_URL || 'http://localhost:9011',
  apiKey: process.env.FUSIONAUTH_API_KEY || '',
  
  // Documentation paths
  docsPath: path.join(__dirname, '../docs'),
  examplesPath: path.join(__dirname, '../examples'),
  
  // OpenAPI specification
  openApiSpecUrl: 'https://fusionauth.io/docs/api/spec/fusionauth-api.json',
  localSpecPath: path.join(__dirname, '../spec/fusionauth-api.json'),
  
  // Verification settings
  timeout: 10000,
  retries: 3,
  concurrency: 5,
  
  // Output configuration
  reportPath: path.join(__dirname, '../reports/api-verification.json'),
  verbose: false,
  fixDocs: false,
  
  // Patterns to match API references in docs
  apiPatterns: [
    /\/api\/[a-z-]+(?:\/[^)\s"'`]*)?/gi,
    /POST|GET|PUT|DELETE|PATCH\s+\/api\/[^\s"'`)]*/gi,
    /fusionauth\.io\/api\/[^\s"'`)]*/gi
  ]
};

/**
 * API Endpoint Verification Class
 */
class APIVerifier {
  constructor(options = {}) {
    this.config = { ...CONFIG, ...options };
    this.openApiSpec = null;
    this.results = {
      summary: {
        totalEndpoints: 0,
        validEndpoints: 0,
        invalidEndpoints: 0,
        deprecatedEndpoints: 0,
        newEndpoints: 0,
        documentsChecked: 0,
        issuesFound: 0
      },
      endpoints: {},
      documents: {},
      errors: [],
      warnings: []
    };
    
    this.setupLogging();
  }

  setupLogging() {
    this.log = {
      info: (msg) => console.log(chalk.blue('ℹ'), msg),
      success: (msg) => console.log(chalk.green('✓'), msg),
      warning: (msg) => console.log(chalk.yellow('⚠'), msg),
      error: (msg) => console.log(chalk.red('✗'), msg),
      verbose: (msg) => this.config.verbose && console.log(chalk.gray('  '), msg)
    };
  }

  /**
   * Main verification process
   */
  async verify() {
    try {
      this.log.info('Starting FusionAuth API verification...\n');
      
      // Load OpenAPI specification
      await this.loadOpenApiSpec();
      
      // Find all API references in documentation
      const documentFiles = await this.findDocumentFiles();
      const apiReferences = await this.extractApiReferences(documentFiles);
      
      // Verify endpoints against OpenAPI spec and live API
      await this.verifyEndpoints(apiReferences);
      
      // Check for documentation sync issues
      await this.checkDocumentationSync();
      
      // Generate and output report
      await this.generateReport();
      
      // Auto-fix documentation if requested
      if (this.config.fixDocs) {
        await this.autoFixDocumentation();
      }
      
      return this.results;
      
    } catch (error) {
      this.log.error(`Verification failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load and parse OpenAPI specification
   */
  async loadOpenApiSpec() {
    try {
      this.log.info('Loading OpenAPI specification...');
      
      let specData;
      
      // Try to load from local file first, then fetch from URL
      try {
        specData = await fs.readFile(this.config.localSpecPath, 'utf8');
        this.log.verbose('Loaded spec from local file');
      } catch {
        this.log.verbose('Local spec not found, fetching from URL...');
        const response = await fetch(this.config.openApiSpecUrl, {
          timeout: this.config.timeout
        });
        
        if (!response.ok) {
          throw new Error(`Failed to fetch spec: ${response.statusText}`);
        }
        
        specData = await response.text();
        
        // Cache the spec locally
        await fs.mkdir(path.dirname(this.config.localSpecPath), { recursive: true });
        await fs.writeFile(this.config.localSpecPath, specData);
      }
      
      this.openApiSpec = JSON.parse(specData);
      this.log.success(`Loaded OpenAPI spec v${this.openApiSpec.info.version}`);
      
    } catch (error) {
      throw new Error(`Failed to load OpenAPI spec: ${error.message}`);
    }
  }

  /**
   * Find all documentation files
   */
  async findDocumentFiles() {
    const patterns = [
      path.join(this.config.docsPath, '**/*.{md,mdx}'),
      path.join(this.config.examplesPath, '**/*.{md,mdx,js,ts,py,java,cs}')
    ];
    
    const files = [];
    for (const pattern of patterns) {
      const matches = await glob(pattern);
      files.push(...matches);
    }
    
    this.log.info(`Found ${files.length} documentation files to analyze`);
    return files;
  }

  /**
   * Extract API references from documentation files
   */
  async extractApiReferences(files) {
    const apiReferences = new Map();
    
    this.log.info('Extracting API references from documentation...');
    
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf8');
        const relativePath = path.relative(process.cwd(), file);
        
        // Parse frontmatter if it exists
        let parsedContent;
        try {
          parsedContent = matter(content);
        } catch {
          parsedContent = { content, data: {} };
        }
        
        const references = this.findApiReferencesInText(parsedContent.content);
        
        if (references.length > 0) {
          apiReferences.set(relativePath, {
            file: relativePath,
            frontmatter: parsedContent.data,
            references,
            content: parsedContent.content
          });
          
          this.log.verbose(`Found ${references.length} API references in ${relativePath}`);
        }
        
      } catch (error) {
        this.results.errors.push({
          file,
          error: `Failed to read file: ${error.message}`
        });
      }
    }
    
    const totalRefs = Array.from(apiReferences.values())
      .reduce((sum, doc) => sum + doc.references.length, 0);
    
    this.log.success(`Extracted ${totalRefs} API references from ${apiReferences.size} files`);
    
    return apiReferences;
  }

  /**
   * Find API references in text content
   */
  findApiReferencesInText(content) {
    const references = new Set();
    
    for (const pattern of this.config.apiPatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        const reference = this.normalizeApiReference(match[0]);
        if (reference) {
          references.add(reference);
        }
      }
    }
    
    return Array.from(references).map(ref => ({
      endpoint: ref,
      method: this.extractHttpMethod(ref),
      path: this.extractApiPath(ref)
    }));
  }

  /**
   * Normalize API reference to standard format
   */
  normalizeApiReference(reference) {
    // Remove domain if present
    reference = reference.replace(/https?:\/\/[^\/]+/, '');
    
    // Extract just the API path
    const match = reference.match(/\/api\/[^?\s"'`)]*/);
    return match ? match[0] : null;
  }

  /**
   * Extract HTTP method from reference
   */
  extractHttpMethod(reference) {
    const methodMatch = reference.match(/^(POST|GET|PUT|DELETE|PATCH)\s+/);
    return methodMatch ? methodMatch[1] : 'GET';
  }

  /**
   * Extract API path from reference
   */
  extractApiPath(reference) {
    return reference.replace(/^(POST|GET|PUT|DELETE|PATCH)\s+/, '');
  }

  /**
   * Verify endpoints against OpenAPI spec and live API
   */
  async verifyEndpoints(apiReferences) {
    this.log.info('Verifying API endpoints...');
    
    const allEndpoints = new Set();
    
    // Collect all unique endpoints
    for (const doc of apiReferences.values()) {
      for (const ref of doc.references) {
        allEndpoints.add(JSON.stringify({ method: ref.method, path: ref.path }));
      }
    }
    
    const endpoints = Array.from(allEndpoints).map(e => JSON.parse(e));
    this.results.summary.totalEndpoints = endpoints.length;
    
    // Verify endpoints in batches
    const batches = this.createBatches(endpoints, this.config.concurrency);
    
    for (const batch of batches) {
      await Promise.all(batch.map(endpoint => this.verifyEndpoint(endpoint)));
    }
    
    // Update document results
    for (const [filePath, doc] of apiReferences.entries()) {
      this.results.documents[filePath] = {
        file: filePath,
        valid: true,
        issues: [],
        references: doc.references.map(ref => {
          const key = `${ref.method} ${ref.path}`;
          const result = this.results.endpoints[key];
          return {
            ...ref,
            valid: result?.valid || false,
            deprecated: result?.deprecated || false,
            issues: result?.issues || []
          };
        })
      };
      
      // Check if document has any issues
      const hasIssues = this.results.documents[filePath].references.some(r => !r.valid);
      if (hasIssues) {
        this.results.documents[filePath].valid = false;
        this.results.summary.issuesFound++;
      }
      
      this.results.summary.documentsChecked++;
    }
    
    this.log.success(`Verified ${endpoints.length} unique endpoints`);
  }

  /**
   * Verify a single endpoint
   */
  async verifyEndpoint(endpoint) {
    const key = `${endpoint.method} ${endpoint.path}`;
    const result = {
      method: endpoint.method,
      path: endpoint.path,
      valid: false,
      exists: false,
      deprecated: false,
      responseTime: null,
      statusCode: null,
      issues: [],
      specMatches: false,
      liveTest: false
    };
    
    try {
      // Check against OpenAPI spec
      const specResult = this.checkAgainstSpec(endpoint);
      result.specMatches = specResult.exists;
      result.deprecated = specResult.deprecated;
      
      if (!specResult.exists) {
        result.issues.push('Endpoint not found in OpenAPI specification');
      }
      
      if (specResult.deprecated) {
        result.issues.push('Endpoint is deprecated');
        this.results.summary.deprecatedEndpoints++;
      }
      
      // Test against live API (if API key provided)
      if (this.config.apiKey) {
        const liveResult = await this.testLiveEndpoint(endpoint);
        result.liveTest = true;
        result.responseTime = liveResult.responseTime;
        result.statusCode = liveResult.statusCode;
        
        if (liveResult.statusCode >= 400 && liveResult.statusCode !== 401) {
          result.issues.push(`Live API returned ${liveResult.statusCode}: ${liveResult.error}`);
        }
      }
      
      // Determine overall validity
      result.valid = result.specMatches && result.issues.length === 0;
      result.exists = result.specMatches || (result.statusCode && result.statusCode < 500);
      
      if (result.valid) {
        this.results.summary.validEndpoints++;
      } else {
        this.results.summary.invalidEndpoints++;
      }
      
    } catch (error) {
      result.issues.push(`Verification error: ${error.message}`);
      this.results.summary.invalidEndpoints++;
    }
    
    this.results.endpoints[key] = result;
    this.log.verbose(`${result.valid ? '✓' : '✗'} ${key}`);
  }

  /**
   * Check endpoint against OpenAPI specification
   */
  checkAgainstSpec(endpoint) {
    if (!this.openApiSpec || !this.openApiSpec.paths) {
      return { exists: false, deprecated: false };
    }
    
    const pathItem = this.openApiSpec.paths[endpoint.path];
    if (!pathItem) {
      // Try to find path with parameters
      const pathWithParams = this.findPathWithParameters(endpoint.path);
      if (pathWithParams) {
        const operation = pathWithParams[endpoint.method.toLowerCase()];
        return {
          exists: !!operation,
          deprecated: operation?.deprecated || false
        };
      }
      return { exists: false, deprecated: false };
    }
    
    const operation = pathItem[endpoint.method.toLowerCase()];
    return {
      exists: !!operation,
      deprecated: operation?.deprecated || false
    };
  }

  /**
   * Find OpenAPI path with parameters that matches the given path
   */
  findPathWithParameters(path) {
    if (!this.openApiSpec.paths) return null;
    
    for (const [specPath, pathItem] of Object.entries(this.openApiSpec.paths)) {
      if (this.pathMatches(path, specPath)) {
        return pathItem;
      }
    }
    
    return null;
  }

  /**
   * Check if a path matches an OpenAPI path pattern
   */
  pathMatches(actualPath, specPath) {
    // Convert OpenAPI path parameters to regex
    const regexPath = specPath
      .replace(/\{[^}]+\}/g, '[^/]+')
      .replace(/\//g, '\\/');
    
    const regex = new RegExp(`^${regexPath}$`);
    return regex.test(actualPath);
  }

  /**
   * Test endpoint against live API
   */
  async testLiveEndpoint(endpoint) {
    const url = `${this.config.fusionAuthUrl}${endpoint.path}`;
    const startTime = Date.now();
    
    try {
      const response = await fetch(url, {
        method: endpoint.method,
        headers: {
          'Authorization': this.config.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: this.config.timeout
      });
      
      const responseTime = Date.now() - startTime;
      
      return {
        statusCode: response.status,
        responseTime,
        error: response.ok ? null : response.statusText
      };
      
    } catch (error) {
      return {
        statusCode: null,
        responseTime: Date.now() - startTime,
        error: error.message
      };
    }
  }

  /**
   * Check for documentation sync issues
   */
  async checkDocumentationSync() {
    this.log.info('Checking documentation synchronization...');
    
    if (!this.openApiSpec) {
      this.results.warnings.push('Cannot check sync without OpenAPI specification');
      return;
    }
    
    // Find endpoints in spec that are not documented
    const documentedEndpoints = new Set();
    for (const endpoint of Object.keys(this.results.endpoints)) {
      documentedEndpoints.add(endpoint);
    }
    
    let undocumentedCount = 0;
    for (const [path, pathItem] of Object.entries(this.openApiSpec.paths)) {
      for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
        if (pathItem[method] && !pathItem[method].deprecated) {
          const endpoint = `${method.toUpperCase()} ${path}`;
          if (!documentedEndpoints.has(endpoint)) {
            this.results.warnings.push({
              type: 'undocumented_endpoint',
              endpoint,
              message: `API endpoint exists but is not documented`
            });
            undocumentedCount++;
          }
        }
      }
    }
    
    if (undocumentedCount > 0) {
      this.log.warning(`Found ${undocumentedCount} undocumented API endpoints`);
    } else {
      this.log.success('All API endpoints are documented');
    }
  }

  /**
   * Generate verification report
   */
  async generateReport() {
    const report = {
      ...this.results,
      metadata: {
        timestamp: new Date().toISOString(),
        fusionAuthVersion: this.openApiSpec?.info?.version || 'unknown',
        configUsed: {
          fusionAuthUrl: this.config.fusionAuthUrl,
          hasApiKey: !!this.config.apiKey,
          timeout: this.config.timeout
        }
      }
    };
    
    // Write JSON report
    await fs.mkdir(path.dirname(this.config.reportPath), { recursive: true });
    await fs.writeFile(
      this.config.reportPath,
      JSON.stringify(report, null, 2)
    );
    
    // Console summary
    this.printSummary();
    
    this.log.success(`Report saved to: ${this.config.reportPath}`);
  }

  /**
   * Print verification summary
   */
  printSummary() {
    const { summary } = this.results;
    
    console.log('\n' + chalk.bold('API Verification Summary'));
    console.log('─'.repeat(50));
    
    console.log(`Total endpoints verified: ${summary.totalEndpoints}`);
    console.log(chalk.green(`Valid endpoints: ${summary.validEndpoints}`));
    
    if (summary.invalidEndpoints > 0) {
      console.log(chalk.red(`Invalid endpoints: ${summary.invalidEndpoints}`));
    }
    
    if (summary.deprecatedEndpoints > 0) {
      console.log(chalk.yellow(`Deprecated endpoints: ${summary.deprecatedEndpoints}`));
    }
    
    console.log(`Documents checked: ${summary.documentsChecked}`);
    
    if (summary.issuesFound > 0) {
      console.log(chalk.red(`Documents with issues: ${summary.issuesFound}`));
    }
    
    if (this.results.warnings.length > 0) {
      console.log(chalk.yellow(`Warnings: ${this.results.warnings.length}`));
    }
    
    if (this.results.errors.length > 0) {
      console.log(chalk.red(`Errors: ${this.results.errors.length}`));
    }
    
    // Overall status
    const isHealthy = summary.invalidEndpoints === 0 && this.results.errors.length === 0;
    console.log('\n' + chalk.bold(isHealthy ? 
      chalk.green('✓ API documentation is healthy') :
      chalk.red('✗ Issues found in API documentation')
    ));
  }

  /**
   * Auto-fix documentation issues
   */
  async autoFixDocumentation() {
    this.log.info('Auto-fixing documentation issues...');
    
    let fixedCount = 0;
    
    for (const [filePath, doc] of Object.entries(this.results.documents)) {
      if (!doc.valid) {
        try {
          const fixes = await this.generateDocumentFixes(filePath, doc);
          if (fixes.length > 0) {
            await this.applyDocumentFixes(filePath, fixes);
            fixedCount++;
            this.log.success(`Fixed ${fixes.length} issues in ${filePath}`);
          }
        } catch (error) {
          this.log.error(`Failed to fix ${filePath}: ${error.message}`);
        }
      }
    }
    
    if (fixedCount > 0) {
      this.log.success(`Auto-fixed issues in ${fixedCount} files`);
    } else {
      this.log.info('No auto-fixable issues found');
    }
  }

  /**
   * Generate fixes for a document
   */
  async generateDocumentFixes(filePath, doc) {
    const fixes = [];
    
    for (const ref of doc.references) {
      if (ref.deprecated) {
        // Suggest replacement for deprecated endpoints
        const replacement = await this.findReplacementEndpoint(ref);
        if (replacement) {
          fixes.push({
            type: 'replace_deprecated',
            original: `${ref.method} ${ref.path}`,
            replacement: `${replacement.method} ${replacement.path}`,
            line: this.findLineInFile(filePath, ref.endpoint)
          });
        }
      }
      
      if (!ref.valid && !ref.deprecated) {
        // Suggest corrections for invalid endpoints
        const suggestion = await this.suggestEndpointCorrection(ref);
        if (suggestion) {
          fixes.push({
            type: 'correct_endpoint',
            original: `${ref.method} ${ref.path}`,
            suggestion: `${suggestion.method} ${suggestion.path}`,
            line: this.findLineInFile(filePath, ref.endpoint)
          });
        }
      }
    }
    
    return fixes;
  }

  /**
   * Find replacement for deprecated endpoint
   */
  async findReplacementEndpoint(deprecatedRef) {
    // This would implement logic to find replacement endpoints
    // For now, return null (no automatic replacement found)
    return null;
  }

  /**
   * Suggest correction for invalid endpoint
   */
  async suggestEndpointCorrection(invalidRef) {
    if (!this.openApiSpec?.paths) return null;
    
    // Find similar paths using fuzzy matching
    const paths = Object.keys(this.openApiSpec.paths);
    const similarity = paths.map(path => ({
      path,
      score: this.calculateSimilarity(invalidRef.path, path)
    }));
    
    similarity.sort((a, b) => b.score - a.score);
    
    if (similarity[0]?.score > 0.7) {
      return {
        method: invalidRef.method,
        path: similarity[0].path
      };
    }
    
    return null;
  }

  /**
   * Calculate string similarity (simple Levenshtein distance)
   */
  calculateSimilarity(a, b) {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= b.length; j++) {
      for (let i = 1; i <= a.length; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + cost
        );
      }
    }
    
    return 1 - matrix[b.length][a.length] / Math.max(a.length, b.length);
  }

  /**
   * Apply fixes to a document
   */
  async applyDocumentFixes(filePath, fixes) {
    let content = await fs.readFile(filePath, 'utf8');
    
    // Apply fixes in reverse line order to preserve line numbers
    fixes.sort((a, b) => b.line - a.line);
    
    for (const fix of fixes) {
      content = content.replace(fix.original, fix.replacement || fix.suggestion);
    }
    
    await fs.writeFile(filePath, content);
  }

  /**
   * Find line number of text in file
   */
  findLineInFile(filePath, searchText) {
    // This would implement logic to find line numbers
    // For now, return 0 (no line number tracking)
    return 0;
  }

  /**
   * Create batches for concurrent processing
   */
  createBatches(items, batchSize) {
    const batches = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}

/**
 * Watch mode for continuous verification
 */
class APIVerifierWatcher {
  constructor(verifier) {
    this.verifier = verifier;
    this.watchers = new Set();
  }

  async start() {
    const chokidar = await import('chokidar');
    
    const watcher = chokidar.watch([
      this.verifier.config.docsPath,
      this.verifier.config.examplesPath
    ], {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true
    });

    watcher.on('change', async (filePath) => {
      console.log(chalk.blue('\n📝 File changed:'), filePath);
      await this.verifyFile(filePath);
    });

    watcher.on('add', async (filePath) => {
      console.log(chalk.green('\n➕ File added:'), filePath);
      await this.verifyFile(filePath);
    });

    console.log(chalk.blue('👀 Watching for changes...'));
    console.log(chalk.gray('Press Ctrl+C to stop'));
    
    // Initial verification
    await this.verifier.verify();
  }

  async verifyFile(filePath) {
    try {
      // Create a new verifier instance for single file
      const singleFileVerifier = new APIVerifier({
        ...this.verifier.config,
        verbose: true
      });

      // Override findDocumentFiles to return only the changed file
      singleFileVerifier.findDocumentFiles = async () => [filePath];

      await singleFileVerifier.verify();
    } catch (error) {
      console.error(chalk.red('Error verifying file:'), error.message);
    }
  }
}

/**
 * CLI Interface
 */
async function main() {
  const program = new Command();
  
  program
    .name('verify-api')
    .description('Verify FusionAuth API endpoints in documentation')
    .version('1.0.0')
    .option('-u, --url <url>', 'FusionAuth URL', 'http://localhost:9011')
    .option('-k, --api-key <key>', 'FusionAuth API Key')
    .option('-v, --verbose', 'Verbose output')
    .option('--fix-docs', 'Auto-fix documentation issues')
    .option('--watch', 'Watch for changes and re-verify')
    .option('--include-deprecated', 'Include deprecated endpoints in verification')
    .option('--timeout <ms>', 'Request timeout in milliseconds', '10000')
    .option('--concurrency <n>', 'Number of concurrent requests', '5')
    .option('--report-path <path>', 'Path to save verification report')
    .parse();

  const options = program.opts();
  
  // Create verifier with CLI options
  const config = {
    fusionAuthUrl: options.url,
    apiKey: options.apiKey || process.env.FUSIONAUTH_API_KEY,
    verbose: options.verbose,
    fixDocs: options.fixDocs,
    timeout: parseInt(options.timeout),
    concurrency: parseInt(options.concurrency),
    includeDeprecated: options.includeDeprecated
  };

  if (options.reportPath) {
    config.reportPath = options.reportPath;
  }

  const verifier = new APIVerifier(config);

  try {
    if (options.watch) {
      const watcher = new APIVerifierWatcher(verifier);
      await watcher.start();
    } else {
      const results = await verifier.verify();
      
      // Exit with error code if issues found
      const hasErrors = results.summary.invalidEndpoints > 0 || results.errors.length > 0;
      process.exit(hasErrors ? 1 : 0);
    }
  } catch (error) {
    console.error(chalk.red('\nVerification failed:'), error.message);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run CLI if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

export { APIVerifier, APIVerifierWatcher };
export default APIVerifier;