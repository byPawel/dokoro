/**
 * Test script for the devlog database module
 */

import { getDb, createDoc, searchDocs, addTagsToDoc, getDocTags, closeAllDbs } from "./index.js";
import * as fs from "node:fs";

async function main() {
  const testDir = "/tmp/dokoro-test-" + Date.now();
  fs.mkdirSync(testDir, { recursive: true });

  console.log("Testing database at:", testDir);

  try {
    const db = getDb({ projectPath: testDir, devlogFolder: "." });

    // Create a test document
    const doc = await createDoc(db, {
      id: "test-doc-1",
      filepath: "test-doc-1.md",
      title: "Test Document",
      content: "This is a test document for the devlog system.",
      docType: "issue",
      status: "inbox",
      tags: ["test", "demo"],
    });

    console.log("Created doc:", doc.id, doc.title);

    // Add more tags
    await addTagsToDoc(db, "test-doc-1", ["urgent", "bug"]);

    // Get tags
    const tags = await getDocTags(db, "test-doc-1");
    console.log(
      "Tags:",
      tags.map((t) => t.name)
    );

    // Search for documents
    const results = await searchDocs(db, { status: "inbox" });
    console.log("Found", results.length, "documents in inbox");

    // Search by text
    const textResults = await searchDocs(db, { query: "test document" });
    console.log("Found", textResults.length, 'documents matching "test document"');

    closeAllDbs();
    console.log("\nTest passed!");
  } finally {
    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  }
}

main().catch(console.error);
