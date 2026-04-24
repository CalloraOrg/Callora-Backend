#!/usr/bin/env node

/**
 * Schema Consolidation Script
 * 
 * This script helps consolidate the schema by removing unused Prisma configuration
 * and ensuring Drizzle is the primary ORM. It creates a backup and provides guidance.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

class SchemaConsolidator {
  constructor() {
    this.backupDir = path.join(projectRoot, '.schema-backup');
    this.consolidate();
  }

  consolidate() {
    console.log('🔧 Consolidating schema configuration...\n');

    this.createBackup();
    this.removeUnusedPrismaFiles();
    this.updatePackageJson();
    this.updateImports();
    this.generateReport();

    console.log('✅ Schema consolidation completed!');
    console.log('\n📋 Next steps:');
    console.log('1. Review the backup in .schema-backup/');
    console.log('2. Run npm install to update dependencies');
    console.log('3. Run the schema drift validation script');
    console.log('4. Test your application thoroughly');
  }

  createBackup() {
    console.log('📦 Creating backup of current schema files...');
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    const filesToBackup = [
      'prisma/schema.prisma',
      'prisma.config.ts',
      'src/lib/prisma.ts',
      'src/generated/prisma'
    ];

    filesToBackup.forEach(filePath => {
      const fullPath = path.join(projectRoot, filePath);
      if (fs.existsSync(fullPath)) {
        const backupPath = path.join(this.backupDir, filePath);
        const backupDir = path.dirname(backupPath);
        
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true });
        }
        
        if (fs.statSync(fullPath).isDirectory()) {
          this.copyDir(fullPath, backupPath);
        } else {
          fs.copyFileSync(fullPath, backupPath);
        }
        console.log(`   ✓ Backed up: ${filePath}`);
      }
    });
  }

  removeUnusedPrismaFiles() {
    console.log('\n🗑️  Removing unused Prisma files...');
    
    const filesToRemove = [
      'prisma/schema.prisma',
      'prisma.config.ts',
      'src/lib/prisma.ts'
    ];

    filesToRemove.forEach(filePath => {
      const fullPath = path.join(projectRoot, filePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log(`   ✓ Removed: ${filePath}`);
      }
    });

    // Remove prisma directory if empty
    const prismaDir = path.join(projectRoot, 'prisma');
    if (fs.existsSync(prismaDir) && fs.readdirSync(prismaDir).length === 0) {
      fs.rmdirSync(prismaDir);
      console.log('   ✓ Removed empty prisma/ directory');
    }

    // Remove generated Prisma client
    const generatedDir = path.join(projectRoot, 'src/generated/prisma');
    if (fs.existsSync(generatedDir)) {
      this.removeDir(generatedDir);
      console.log('   ✓ Removed: src/generated/prisma/');
    }
  }

  updatePackageJson() {
    console.log('\n📝 Updating package.json...');
    
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    // Remove Prisma dependencies
    const prismaDeps = [
      '@prisma/adapter-pg',
      '@prisma/client',
      'prisma'
    ];

    let removedDeps = 0;
    prismaDeps.forEach(dep => {
      if (packageJson.dependencies) {
        delete packageJson.dependencies[dep];
        removedDeps++;
      }
      if (packageJson.devDependencies) {
        delete packageJson.devDependencies[dep];
      }
    });

    // Add Drizzle dependencies if not present
    const drizzleDeps = {
      'drizzle-orm': '^0.29.0',
      'better-sqlite3': '^9.2.2',
      'drizzle-kit': '^0.20.7'
    };

    Object.entries(drizzleDeps).forEach(([dep, version]) => {
      if (!packageJson.dependencies?.[dep] && !packageJson.devDependencies?.[dep]) {
        if (!packageJson.dependencies) packageJson.dependencies = {};
        packageJson.dependencies[dep] = version;
      }
    });

    // Update scripts
    if (!packageJson.scripts) packageJson.scripts = {};
    packageJson.scripts['db:generate'] = 'drizzle-kit generate:sqlite';
    packageJson.scripts['db:migrate'] = 'drizzle-kit migrate';
    packageJson.scripts['db:studio'] = 'drizzle-kit studio';
    packageJson.scripts['validate:schema'] = 'node scripts/schema-drift-validator.mjs';

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    console.log(`   ✓ Removed ${removedDeps} Prisma dependencies`);
    console.log('   ✓ Updated scripts for Drizzle');
  }

  updateImports() {
    console.log('\n🔄 Updating imports...');
    
    const srcDir = path.join(projectRoot, 'src');
    this.processDirectory(srcDir);
  }

  processDirectory(dir) {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        this.processDirectory(fullPath);
      } else if (item.endsWith('.ts')) {
        this.updateFileImports(fullPath);
      }
    }
  }

  updateFileImports(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let updated = false;

    // Remove Prisma imports
    const prismaImports = [
      "import { PrismaClient }",
      "import { PrismaPg }",
      "import '../lib/prisma.js'",
      "import '../generated/prisma/client.js'"
    ];

    prismaImports.forEach(imp => {
      if (content.includes(imp)) {
        content = content.replace(new RegExp(imp + '[^\\n]*\\n?', 'g'), '');
        updated = true;
      }
    });

    // Remove disconnectPrisma calls
    content = content.replace(/disconnectPrisma\(\)[^\\n]*\\n?/g, '');
    content = content.replace(/await disconnectPrisma\(\)[^\\n]*\\n?/g, '');

    // Remove from Promise.allSettled arrays
    content = content.replace(/disconnectPrisma\(\),?/g, '');

    if (updated) {
      fs.writeFileSync(filePath, content);
      const relativePath = path.relative(projectRoot, filePath);
      console.log(`   ✓ Updated: ${relativePath}`);
    }
  }

  generateReport() {
    console.log('\n📊 Consolidation Report:');
    console.log('========================');
    console.log('✅ Removed Prisma configuration');
    console.log('✅ Consolidated to Drizzle + SQLite');
    console.log('✅ Updated package.json dependencies');
    console.log('✅ Cleaned up imports');
    console.log('✅ Created backup of removed files');
    
    console.log('\n⚠️  Manual review required:');
    console.log('- Check for any remaining Prisma usage in tests');
    console.log('- Verify database connection strings');
    console.log('- Test all database operations');
    console.log('- Update any documentation referencing Prisma');
  }

  copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  removeDir(dir) {
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          this.removeDir(fullPath);
        } else {
          fs.unlinkSync(fullPath);
        }
      }

      fs.rmdirSync(dir);
    }
  }
}

// Run the consolidator
new SchemaConsolidator();
