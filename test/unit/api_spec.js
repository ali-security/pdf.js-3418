/* Copyright 2017 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AnnotationMode,
  AnnotationType,
  createPromiseCapability,
  ImageKind,
  InvalidPDFException,
  MissingPDFException,
  OPS,
  PasswordException,
  PasswordResponses,
  PermissionFlag,
  UnknownErrorException,
} from "../../src/shared/util.js";
import {
  buildGetDocumentParams,
  DefaultFileReaderFactory,
  TEST_PDFS_PATH,
} from "./test_utils.js";
import {
  DefaultCanvasFactory,
  getDocument,
  PDFDataRangeTransport,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PDFWorker,
  PDFWorkerUtil,
  RenderTask,
} from "../../src/display/api.js";
import {
  PageViewport,
  RenderingCancelledException,
  StatTimer,
} from "../../src/display/display_utils.js";
import { AnnotationStorage } from "../../src/display/annotation_storage.js";
import { AutoPrintRegExp } from "../../web/ui_utils.js";
import { GlobalImageCache } from "../../src/core/image_utils.js";
import { GlobalWorkerOptions } from "../../src/display/worker_options.js";
import { isNodeJS } from "../../src/shared/is_node.js";
import { Metadata } from "../../src/display/metadata.js";

describe("api", function () {
  const basicApiFileName = "basicapi.pdf";
  const basicApiFileLength = 105779; // bytes
  const basicApiGetDocumentParams = buildGetDocumentParams(basicApiFileName);

  let CanvasFactory;

  beforeAll(function () {
    CanvasFactory = new DefaultCanvasFactory();
  });

  afterAll(function () {
    CanvasFactory = null;
  });

  function waitSome(callback) {
    const WAIT_TIMEOUT = 10;
    setTimeout(function () {
      callback();
    }, WAIT_TIMEOUT);
  }

  function mergeText(items) {
    return items
      .map(chunk => (chunk.str ?? "") + (chunk.hasEOL ? "\n" : ""))
      .join("");
  }

  function getNamedNodeInXML(node, path) {
    for (const component of path.split(".")) {
      if (!node.childNodes) {
        break;
      }
      for (const child of node.childNodes) {
        if (child.nodeName === component) {
          node = child;
          break;
        }
      }
    }
    return node;
  }

  describe("getDocument", function () {
    it("creates pdf doc from URL-string", async function () {
      const urlStr = TEST_PDFS_PATH + basicApiFileName;
      const loadingTask = getDocument(urlStr);
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);
      const pdfDocument = await loadingTask.promise;

      expect(typeof urlStr).toEqual("string");
      expect(pdfDocument instanceof PDFDocumentProxy).toEqual(true);
      expect(pdfDocument.numPages).toEqual(3);

      await loadingTask.destroy();
    });

    it("creates pdf doc from URL-object", async function () {
      if (isNodeJS) {
        pending("window.location is not supported in Node.js.");
      }
      const urlObj = new URL(
        TEST_PDFS_PATH + basicApiFileName,
        window.location
      );
      const loadingTask = getDocument(urlObj);
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);
      const pdfDocument = await loadingTask.promise;

      expect(urlObj instanceof URL).toEqual(true);
      expect(pdfDocument instanceof PDFDocumentProxy).toEqual(true);
      expect(pdfDocument.numPages).toEqual(3);

      await loadingTask.destroy();
    });

    it("creates pdf doc from URL", async function () {
      const loadingTask = getDocument(basicApiGetDocumentParams);
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const progressReportedCapability = createPromiseCapability();
      // Attach the callback that is used to report loading progress;
      // similarly to how viewer.js works.
      loadingTask.onProgress = function (progressData) {
        if (!progressReportedCapability.settled) {
          progressReportedCapability.resolve(progressData);
        }
      };

      const data = await Promise.all([
        progressReportedCapability.promise,
        loadingTask.promise,
      ]);

      expect(data[0].loaded / data[0].total >= 0).toEqual(true);
      expect(data[1] instanceof PDFDocumentProxy).toEqual(true);
      expect(loadingTask).toEqual(data[1].loadingTask);

      await loadingTask.destroy();
    });

    it("creates pdf doc from URL and aborts before worker initialized", async function () {
      const loadingTask = getDocument(basicApiGetDocumentParams);
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);
      const destroyed = loadingTask.destroy();

      try {
        await loadingTask.promise;

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(true).toEqual(true);
        await destroyed;
      }
    });

    it("creates pdf doc from URL and aborts loading after worker initialized", async function () {
      const loadingTask = getDocument(basicApiGetDocumentParams);
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);
      // This can be somewhat random -- we cannot guarantee perfect
      // 'Terminate' message to the worker before/after setting up pdfManager.
      const destroyed = loadingTask._worker.promise.then(function () {
        return loadingTask.destroy();
      });

      await destroyed;
      expect(true).toEqual(true);
    });

    it("creates pdf doc from TypedArray", async function () {
      const typedArrayPdf = await DefaultFileReaderFactory.fetch({
        path: TEST_PDFS_PATH + basicApiFileName,
      });

      // Sanity check to make sure that we fetched the entire PDF file.
      expect(typedArrayPdf instanceof Uint8Array).toEqual(true);
      expect(typedArrayPdf.length).toEqual(basicApiFileLength);

      const loadingTask = getDocument(typedArrayPdf);
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const progressReportedCapability = createPromiseCapability();
      loadingTask.onProgress = function (data) {
        progressReportedCapability.resolve(data);
      };

      const data = await Promise.all([
        loadingTask.promise,
        progressReportedCapability.promise,
      ]);
      expect(data[0] instanceof PDFDocumentProxy).toEqual(true);
      expect(data[1].loaded / data[1].total).toEqual(1);

      if (!isNodeJS) {
        // Check that the TypedArray was transferred.
        expect(typedArrayPdf.length).toEqual(0);
      }

      await loadingTask.destroy();
    });

    it("creates pdf doc from ArrayBuffer", async function () {
      const { buffer: arrayBufferPdf } = await DefaultFileReaderFactory.fetch({
        path: TEST_PDFS_PATH + basicApiFileName,
      });

      // Sanity check to make sure that we fetched the entire PDF file.
      expect(arrayBufferPdf instanceof ArrayBuffer).toEqual(true);
      expect(arrayBufferPdf.byteLength).toEqual(basicApiFileLength);

      const loadingTask = getDocument(arrayBufferPdf);
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const progressReportedCapability = createPromiseCapability();
      loadingTask.onProgress = function (data) {
        progressReportedCapability.resolve(data);
      };

      const data = await Promise.all([
        loadingTask.promise,
        progressReportedCapability.promise,
      ]);
      expect(data[0] instanceof PDFDocumentProxy).toEqual(true);
      expect(data[1].loaded / data[1].total).toEqual(1);

      if (!isNodeJS) {
        // Check that the ArrayBuffer was transferred.
        expect(arrayBufferPdf.byteLength).toEqual(0);
      }

      await loadingTask.destroy();
    });

    it("creates pdf doc from invalid PDF file", async function () {
      // A severely corrupt PDF file (even Adobe Reader fails to open it).
      const loadingTask = getDocument(buildGetDocumentParams("bug1020226.pdf"));
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      try {
        await loadingTask.promise;

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof InvalidPDFException).toEqual(true);
        expect(reason.message).toEqual("Invalid PDF structure.");
      }

      await loadingTask.destroy();
    });

    it("creates pdf doc from non-existent URL", async function () {
      if (!isNodeJS) {
        // Re-enable in https://github.com/mozilla/pdf.js/issues/13061.
        pending("Fails intermittently on Linux in browsers.");
      }
      const loadingTask = getDocument(
        buildGetDocumentParams("non-existent.pdf")
      );
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      try {
        await loadingTask.promise;

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof MissingPDFException).toEqual(true);
      }

      await loadingTask.destroy();
    });

    it("creates pdf doc from PDF file protected with user and owner password", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("pr6531_1.pdf"));
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const passwordNeededCapability = createPromiseCapability();
      const passwordIncorrectCapability = createPromiseCapability();
      // Attach the callback that is used to request a password;
      // similarly to how the default viewer handles passwords.
      loadingTask.onPassword = function (updatePassword, reason) {
        if (
          reason === PasswordResponses.NEED_PASSWORD &&
          !passwordNeededCapability.settled
        ) {
          passwordNeededCapability.resolve();

          updatePassword("qwerty"); // Provide an incorrect password.
          return;
        }
        if (
          reason === PasswordResponses.INCORRECT_PASSWORD &&
          !passwordIncorrectCapability.settled
        ) {
          passwordIncorrectCapability.resolve();

          updatePassword("asdfasdf"); // Provide the correct password.
          return;
        }
        // Shouldn't get here.
        expect(false).toEqual(true);
      };

      const data = await Promise.all([
        passwordNeededCapability.promise,
        passwordIncorrectCapability.promise,
        loadingTask.promise,
      ]);
      expect(data[2] instanceof PDFDocumentProxy).toEqual(true);

      await loadingTask.destroy();
    });

    it("creates pdf doc from PDF file protected with only a user password", async function () {
      const filename = "pr6531_2.pdf";

      const passwordNeededLoadingTask = getDocument(
        buildGetDocumentParams(filename, {
          password: "",
        })
      );
      expect(
        passwordNeededLoadingTask instanceof PDFDocumentLoadingTask
      ).toEqual(true);

      const result1 = passwordNeededLoadingTask.promise.then(
        function () {
          // Shouldn't get here.
          expect(false).toEqual(true);
          return Promise.reject(new Error("loadingTask should be rejected"));
        },
        function (data) {
          expect(data instanceof PasswordException).toEqual(true);
          expect(data.code).toEqual(PasswordResponses.NEED_PASSWORD);
          return passwordNeededLoadingTask.destroy();
        }
      );

      const passwordIncorrectLoadingTask = getDocument(
        buildGetDocumentParams(filename, {
          password: "qwerty",
        })
      );
      expect(
        passwordIncorrectLoadingTask instanceof PDFDocumentLoadingTask
      ).toEqual(true);

      const result2 = passwordIncorrectLoadingTask.promise.then(
        function () {
          // Shouldn't get here.
          expect(false).toEqual(true);
          return Promise.reject(new Error("loadingTask should be rejected"));
        },
        function (data) {
          expect(data instanceof PasswordException).toEqual(true);
          expect(data.code).toEqual(PasswordResponses.INCORRECT_PASSWORD);
          return passwordIncorrectLoadingTask.destroy();
        }
      );

      const passwordAcceptedLoadingTask = getDocument(
        buildGetDocumentParams(filename, {
          password: "asdfasdf",
        })
      );
      expect(
        passwordAcceptedLoadingTask instanceof PDFDocumentLoadingTask
      ).toEqual(true);

      const result3 = passwordAcceptedLoadingTask.promise.then(function (data) {
        expect(data instanceof PDFDocumentProxy).toEqual(true);
        return passwordAcceptedLoadingTask.destroy();
      });

      await Promise.all([result1, result2, result3]);
    });

    it(
      "creates pdf doc from password protected PDF file and aborts/throws " +
        "in the onPassword callback (issue 7806)",
      async function () {
        const filename = "issue3371.pdf";

        const passwordNeededLoadingTask = getDocument(
          buildGetDocumentParams(filename)
        );
        expect(
          passwordNeededLoadingTask instanceof PDFDocumentLoadingTask
        ).toEqual(true);

        const passwordIncorrectLoadingTask = getDocument(
          buildGetDocumentParams(filename, {
            password: "qwerty",
          })
        );
        expect(
          passwordIncorrectLoadingTask instanceof PDFDocumentLoadingTask
        ).toEqual(true);

        let passwordNeededDestroyed;
        passwordNeededLoadingTask.onPassword = function (callback, reason) {
          if (reason === PasswordResponses.NEED_PASSWORD) {
            passwordNeededDestroyed = passwordNeededLoadingTask.destroy();
            return;
          }
          // Shouldn't get here.
          expect(false).toEqual(true);
        };
        const result1 = passwordNeededLoadingTask.promise.then(
          function () {
            // Shouldn't get here.
            expect(false).toEqual(true);
            return Promise.reject(new Error("loadingTask should be rejected"));
          },
          function (reason) {
            expect(reason instanceof PasswordException).toEqual(true);
            expect(reason.code).toEqual(PasswordResponses.NEED_PASSWORD);
            return passwordNeededDestroyed;
          }
        );

        passwordIncorrectLoadingTask.onPassword = function (callback, reason) {
          if (reason === PasswordResponses.INCORRECT_PASSWORD) {
            throw new Error("Incorrect password");
          }
          // Shouldn't get here.
          expect(false).toEqual(true);
        };
        const result2 = passwordIncorrectLoadingTask.promise.then(
          function () {
            // Shouldn't get here.
            expect(false).toEqual(true);
            return Promise.reject(new Error("loadingTask should be rejected"));
          },
          function (reason) {
            expect(reason instanceof PasswordException).toEqual(true);
            expect(reason.code).toEqual(PasswordResponses.INCORRECT_PASSWORD);
            return passwordIncorrectLoadingTask.destroy();
          }
        );

        await Promise.all([result1, result2]);
      }
    );

    it(
      "creates pdf doc from password protected PDF file and passes an Error " +
        "(asynchronously) to the onPassword callback (bug 1754421)",
      async function () {
        const loadingTask = getDocument(
          buildGetDocumentParams("issue3371.pdf")
        );
        expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

        // Attach the callback that is used to request a password;
        // similarly to how the default viewer handles passwords.
        loadingTask.onPassword = function (updatePassword, reason) {
          waitSome(() => {
            updatePassword(new Error("Should reject the loadingTask."));
          });
        };

        await loadingTask.promise.then(
          function () {
            // Shouldn't get here.
            expect(false).toEqual(true);
          },
          function (reason) {
            expect(reason instanceof PasswordException).toEqual(true);
            expect(reason.code).toEqual(PasswordResponses.NEED_PASSWORD);
          }
        );

        await loadingTask.destroy();
      }
    );

    it("creates pdf doc from empty TypedArray", async function () {
      const loadingTask = getDocument(new Uint8Array(0));
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      try {
        await loadingTask.promise;

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof InvalidPDFException).toEqual(true);
        expect(reason.message).toEqual(
          "The PDF file is empty, i.e. its size is zero bytes."
        );
      }

      await loadingTask.destroy();
    });

    it("checks that `docId`s are unique and increasing", async function () {
      const loadingTask1 = getDocument(basicApiGetDocumentParams);
      expect(loadingTask1 instanceof PDFDocumentLoadingTask).toEqual(true);
      await loadingTask1.promise;
      const docId1 = loadingTask1.docId;

      const loadingTask2 = getDocument(basicApiGetDocumentParams);
      expect(loadingTask2 instanceof PDFDocumentLoadingTask).toEqual(true);
      await loadingTask2.promise;
      const docId2 = loadingTask2.docId;

      expect(docId1).not.toEqual(docId2);

      const docIdRegExp = /^d(\d+)$/,
        docNum1 = docIdRegExp.exec(docId1)?.[1],
        docNum2 = docIdRegExp.exec(docId2)?.[1];

      expect(+docNum1).toBeLessThan(+docNum2);

      await Promise.all([loadingTask1.destroy(), loadingTask2.destroy()]);
    });

    it("creates pdf doc from PDF file with bad XRef entry", async function () {
      // A corrupt PDF file, where the XRef table have (some) bogus entries.
      const loadingTask = getDocument(
        buildGetDocumentParams("PDFBOX-4352-0.pdf", {
          rangeChunkSize: 100,
        })
      );
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const pdfDocument = await loadingTask.promise;
      expect(pdfDocument.numPages).toEqual(1);

      const page = await pdfDocument.getPage(1);
      expect(page instanceof PDFPageProxy).toEqual(true);

      const opList = await page.getOperatorList();
      expect(opList.fnArray.length).toEqual(0);
      expect(opList.argsArray.length).toEqual(0);
      expect(opList.lastChunk).toEqual(true);
      expect(opList.separateAnnots).toEqual(null);

      await loadingTask.destroy();
    });

    it("creates pdf doc from PDF file with bad XRef header", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("GHOSTSCRIPT-698804-1-fuzzed.pdf")
      );
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const pdfDocument = await loadingTask.promise;
      expect(pdfDocument.numPages).toEqual(1);

      const page = await pdfDocument.getPage(1);
      expect(page instanceof PDFPageProxy).toEqual(true);

      const opList = await page.getOperatorList();
      expect(opList.fnArray.length).toEqual(0);
      expect(opList.argsArray.length).toEqual(0);
      expect(opList.lastChunk).toEqual(true);
      expect(opList.separateAnnots).toEqual(null);

      await loadingTask.destroy();
    });

    it("creates pdf doc from PDF file with bad XRef byteWidths", async function () {
      // A corrupt PDF file, where the XRef /W-array have (some) bogus entries.
      const loadingTask = getDocument(
        buildGetDocumentParams("REDHAT-1531897-0.pdf")
      );
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      try {
        await loadingTask.promise;

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof InvalidPDFException).toEqual(true);
        expect(reason.message).toEqual("Invalid PDF structure.");
      }

      await loadingTask.destroy();
    });

    it("creates pdf doc from PDF file with inaccessible /Pages tree", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("poppler-395-0-fuzzed.pdf")
      );
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      try {
        await loadingTask.promise;

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof InvalidPDFException).toEqual(true);
        expect(reason.message).toEqual("Invalid Root reference.");
      }

      await loadingTask.destroy();
    });

    it("creates pdf doc from PDF files, with bad /Pages tree /Count", async function () {
      const loadingTask1 = getDocument(
        buildGetDocumentParams("poppler-67295-0.pdf")
      );
      const loadingTask2 = getDocument(
        buildGetDocumentParams("poppler-85140-0.pdf")
      );
      const loadingTask3 = getDocument(
        buildGetDocumentParams("poppler-85140-0.pdf", { stopAtErrors: true })
      );

      expect(loadingTask1 instanceof PDFDocumentLoadingTask).toEqual(true);
      expect(loadingTask2 instanceof PDFDocumentLoadingTask).toEqual(true);
      expect(loadingTask3 instanceof PDFDocumentLoadingTask).toEqual(true);

      const pdfDocument1 = await loadingTask1.promise;
      const pdfDocument2 = await loadingTask2.promise;
      const pdfDocument3 = await loadingTask3.promise;

      expect(pdfDocument1.numPages).toEqual(1);
      expect(pdfDocument2.numPages).toEqual(1);
      expect(pdfDocument3.numPages).toEqual(1);

      const pageA = await pdfDocument1.getPage(1);
      expect(pageA instanceof PDFPageProxy).toEqual(true);

      const opListA = await pageA.getOperatorList();
      expect(opListA.fnArray.length).toBeGreaterThan(5);
      expect(opListA.argsArray.length).toBeGreaterThan(5);
      expect(opListA.lastChunk).toEqual(true);
      expect(opListA.separateAnnots).toEqual(null);

      const pageB = await pdfDocument2.getPage(1);
      expect(pageB instanceof PDFPageProxy).toEqual(true);

      const opListB = await pageB.getOperatorList();
      expect(opListB.fnArray.length).toBe(0);
      expect(opListB.argsArray.length).toBe(0);
      expect(opListB.lastChunk).toEqual(true);
      expect(opListB.separateAnnots).toEqual(null);

      try {
        await pdfDocument3.getPage(1);

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof UnknownErrorException).toEqual(true);
        expect(reason.message).toEqual("Bad (uncompressed) XRef entry: 3R");
      }

      await Promise.all([
        loadingTask1.destroy(),
        loadingTask2.destroy(),
        loadingTask3.destroy(),
      ]);
    });

    it("creates pdf doc from PDF files, with circular references", async function () {
      const loadingTask1 = getDocument(
        buildGetDocumentParams("poppler-91414-0-53.pdf")
      );
      const loadingTask2 = getDocument(
        buildGetDocumentParams("poppler-91414-0-54.pdf")
      );
      expect(loadingTask1 instanceof PDFDocumentLoadingTask).toEqual(true);
      expect(loadingTask2 instanceof PDFDocumentLoadingTask).toEqual(true);

      const pdfDocument1 = await loadingTask1.promise;
      const pdfDocument2 = await loadingTask2.promise;

      expect(pdfDocument1.numPages).toEqual(1);
      expect(pdfDocument2.numPages).toEqual(1);

      const pageA = await pdfDocument1.getPage(1);
      const pageB = await pdfDocument2.getPage(1);

      expect(pageA instanceof PDFPageProxy).toEqual(true);
      expect(pageB instanceof PDFPageProxy).toEqual(true);

      for (const opList of [
        await pageA.getOperatorList(),
        await pageB.getOperatorList(),
      ]) {
        expect(opList.fnArray.length).toBeGreaterThan(5);
        expect(opList.argsArray.length).toBeGreaterThan(5);
        expect(opList.lastChunk).toEqual(true);
        expect(opList.separateAnnots).toEqual(null);
      }

      await Promise.all([loadingTask1.destroy(), loadingTask2.destroy()]);
    });

    it("creates pdf doc from PDF files, with bad /Pages tree /Kids entries", async function () {
      const loadingTask1 = getDocument(
        buildGetDocumentParams("poppler-742-0-fuzzed.pdf")
      );
      const loadingTask2 = getDocument(
        buildGetDocumentParams("poppler-937-0-fuzzed.pdf")
      );
      expect(loadingTask1 instanceof PDFDocumentLoadingTask).toEqual(true);
      expect(loadingTask2 instanceof PDFDocumentLoadingTask).toEqual(true);

      const pdfDocument1 = await loadingTask1.promise;
      const pdfDocument2 = await loadingTask2.promise;

      expect(pdfDocument1.numPages).toEqual(1);
      expect(pdfDocument2.numPages).toEqual(1);

      try {
        await pdfDocument1.getPage(1);

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof UnknownErrorException).toEqual(true);
        expect(reason.message).toEqual("Illegal character: 41");
      }
      try {
        await pdfDocument2.getPage(1);

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof UnknownErrorException).toEqual(true);
        expect(reason.message).toEqual("End of file inside array.");
      }

      await Promise.all([loadingTask1.destroy(), loadingTask2.destroy()]);
    });

    it("creates pdf doc from PDF file with bad /Resources entry", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue15150.pdf"));
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const pdfDocument = await loadingTask.promise;
      expect(pdfDocument.numPages).toEqual(1);

      const page = await pdfDocument.getPage(1);
      expect(page instanceof PDFPageProxy).toEqual(true);

      const opList = await page.getOperatorList();
      expect(opList.fnArray).toEqual([
        OPS.setLineWidth,
        OPS.setStrokeRGBColor,
        OPS.constructPath,
        OPS.closeStroke,
      ]);
      expect(opList.argsArray).toEqual([
        [0.5],
        new Uint8ClampedArray([255, 0, 0]),
        [
          [OPS.moveTo, OPS.lineTo],
          [0, 9.75, 0.5, 9.75],
          [0, 0.5, 9.75, 9.75],
        ],
        null,
      ]);
      expect(opList.lastChunk).toEqual(true);

      await loadingTask.destroy();
    });

    it("creates pdf doc from PDF file, with incomplete trailer", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue15590.pdf"));
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const pdfDocument = await loadingTask.promise;
      expect(pdfDocument.numPages).toEqual(1);

      const jsActions = await pdfDocument.getJSActions();
      expect(jsActions).toEqual({
        OpenAction: ["func=function(){app.alert(1)};func();"],
      });

      const page = await pdfDocument.getPage(1);
      expect(page instanceof PDFPageProxy).toEqual(true);

      await loadingTask.destroy();
    });
  });

  describe("PDFWorker", function () {
    it("worker created or destroyed", async function () {
      if (isNodeJS) {
        pending("Worker is not supported in Node.js.");
      }

      const worker = new PDFWorker({ name: "test1" });
      await worker.promise;
      expect(worker.name).toEqual("test1");
      expect(!!worker.port).toEqual(true);
      expect(worker.destroyed).toEqual(false);
      expect(!!worker._webWorker).toEqual(true);
      expect(worker.port === worker._webWorker).toEqual(true);

      worker.destroy();
      expect(!!worker.port).toEqual(false);
      expect(worker.destroyed).toEqual(true);
    });

    it("worker created or destroyed by getDocument", async function () {
      if (isNodeJS) {
        pending("Worker is not supported in Node.js.");
      }

      const loadingTask = getDocument(basicApiGetDocumentParams);
      let worker;
      loadingTask.promise.then(function () {
        worker = loadingTask._worker;
        expect(!!worker).toEqual(true);
      });

      const destroyPromise = loadingTask.promise.then(function () {
        return loadingTask.destroy();
      });
      await destroyPromise;

      const destroyedWorker = loadingTask._worker;
      expect(!!destroyedWorker).toEqual(false);
      expect(worker.destroyed).toEqual(true);
    });

    it("worker created and can be used in getDocument", async function () {
      if (isNodeJS) {
        pending("Worker is not supported in Node.js.");
      }

      const worker = new PDFWorker({ name: "test1" });
      const loadingTask = getDocument(
        buildGetDocumentParams(basicApiFileName, {
          worker,
        })
      );
      loadingTask.promise.then(function () {
        const docWorker = loadingTask._worker;
        expect(!!docWorker).toEqual(false);
        // checking is the same port is used in the MessageHandler
        const messageHandlerPort = loadingTask._transport.messageHandler.comObj;
        expect(messageHandlerPort === worker.port).toEqual(true);
      });

      const destroyPromise = loadingTask.promise.then(function () {
        return loadingTask.destroy();
      });
      await destroyPromise;

      expect(worker.destroyed).toEqual(false);
      worker.destroy();
    });

    it("creates more than one worker", async function () {
      if (isNodeJS) {
        pending("Worker is not supported in Node.js.");
      }

      const worker1 = new PDFWorker({ name: "test1" });
      const worker2 = new PDFWorker({ name: "test2" });
      const worker3 = new PDFWorker({ name: "test3" });
      await Promise.all([worker1.promise, worker2.promise, worker3.promise]);

      expect(
        worker1.port !== worker2.port &&
          worker1.port !== worker3.port &&
          worker2.port !== worker3.port
      ).toEqual(true);
      worker1.destroy();
      worker2.destroy();
      worker3.destroy();
    });

    it("gets current workerSrc", function () {
      if (isNodeJS) {
        pending("Worker is not supported in Node.js.");
      }

      const workerSrc = PDFWorker.workerSrc;
      expect(typeof workerSrc).toEqual("string");
      expect(workerSrc).toEqual(GlobalWorkerOptions.workerSrc);
    });
  });

  describe("PDFDocument", function () {
    let pdfLoadingTask, pdfDocument;

    beforeAll(async function () {
      pdfLoadingTask = getDocument(basicApiGetDocumentParams);
      pdfDocument = await pdfLoadingTask.promise;
    });

    afterAll(async function () {
      await pdfLoadingTask.destroy();
    });

    it("gets number of pages", function () {
      expect(pdfDocument.numPages).toEqual(3);
    });

    it("gets fingerprints", function () {
      expect(pdfDocument.fingerprints).toEqual([
        "ea8b35919d6279a369e835bde778611b",
        null,
      ]);
    });

    it("gets fingerprints, from modified document", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("annotation-tx.pdf")
      );
      const pdfDoc = await loadingTask.promise;

      expect(pdfDoc.fingerprints).toEqual([
        "3ebd77c320274649a68f10dbf3b9f882",
        "e7087346aa4b4ae0911c1f1643b57345",
      ]);

      await loadingTask.destroy();
    });

    it("gets page", async function () {
      const data = await pdfDocument.getPage(1);
      expect(data instanceof PDFPageProxy).toEqual(true);
      expect(data.pageNumber).toEqual(1);
    });

    it("gets non-existent page", async function () {
      const pageNumbers = [
        /* outOfRange = */ 100,
        /* nonInteger = */ 2.5,
        /* nonNumber = */ "1",
      ];

      for (const pageNumber of pageNumbers) {
        try {
          await pdfDocument.getPage(pageNumber);

          // Shouldn't get here.
          expect(false).toEqual(true);
        } catch (reason) {
          expect(reason instanceof Error).toEqual(true);
          expect(reason.message).toEqual("Invalid page request.");
        }
      }
    });

    it("gets page, from /Pages tree with circular reference", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("Pages-tree-refs.pdf")
      );

      const page1 = loadingTask.promise.then(function (pdfDoc) {
        return pdfDoc.getPage(1).then(
          function (pdfPage) {
            expect(pdfPage instanceof PDFPageProxy).toEqual(true);
            expect(pdfPage.ref).toEqual({ num: 6, gen: 0 });
          },
          function (reason) {
            throw new Error("shall not fail for valid page");
          }
        );
      });

      const page2 = loadingTask.promise.then(function (pdfDoc) {
        return pdfDoc.getPage(2).then(
          function (pdfPage) {
            throw new Error("shall fail for invalid page");
          },
          function (reason) {
            expect(reason instanceof UnknownErrorException).toEqual(true);
            expect(reason.message).toEqual(
              "Pages tree contains circular reference."
            );
          }
        );
      });

      await Promise.all([page1, page2]);
      await loadingTask.destroy();
    });

    it("gets page multiple time, with working caches", async function () {
      const promiseA = pdfDocument.getPage(1);
      const promiseB = pdfDocument.getPage(1);

      expect(promiseA instanceof Promise).toEqual(true);
      expect(promiseA).toBe(promiseB);

      const pageA = await promiseA;
      const pageB = await promiseB;

      expect(pageA instanceof PDFPageProxy).toEqual(true);
      expect(pageA).toBe(pageB);
    });

    it("gets page index", async function () {
      const ref = { num: 17, gen: 0 }; // Reference to second page.
      const pageIndex = await pdfDocument.getPageIndex(ref);
      expect(pageIndex).toEqual(1);
    });

    it("gets invalid page index", async function () {
      const pageRefs = [
        /* fontRef = */ { num: 3, gen: 0 },
        /* invalidRef = */ { num: -1, gen: 0 },
        /* nonRef = */ "qwerty",
        /* nullRef = */ null,
      ];

      const expectedErrors = [
        {
          exception: UnknownErrorException,
          message: "The reference does not point to a /Page dictionary.",
        },
        { exception: Error, message: "Invalid pageIndex request." },
        { exception: Error, message: "Invalid pageIndex request." },
        { exception: Error, message: "Invalid pageIndex request." },
      ];

      for (let i = 0, ii = pageRefs.length; i < ii; i++) {
        try {
          await pdfDocument.getPageIndex(pageRefs[i]);

          // Shouldn't get here.
          expect(false).toEqual(true);
        } catch (reason) {
          const { exception, message } = expectedErrors[i];

          expect(reason instanceof exception).toEqual(true);
          expect(reason.message).toEqual(message);
        }
      }
    });

    it("gets destinations, from /Dests dictionary", async function () {
      const destinations = await pdfDocument.getDestinations();
      expect(destinations).toEqual({
        chapter1: [{ gen: 0, num: 17 }, { name: "XYZ" }, 0, 841.89, null],
      });
    });

    it("gets a destination, from /Dests dictionary", async function () {
      const destination = await pdfDocument.getDestination("chapter1");
      expect(destination).toEqual([
        { gen: 0, num: 17 },
        { name: "XYZ" },
        0,
        841.89,
        null,
      ]);
    });

    it("gets a non-existent destination, from /Dests dictionary", async function () {
      const destination = await pdfDocument.getDestination(
        "non-existent-named-destination"
      );
      expect(destination).toEqual(null);
    });

    it("gets destinations, from /Names (NameTree) dictionary", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue6204.pdf"));
      const pdfDoc = await loadingTask.promise;
      const destinations = await pdfDoc.getDestinations();
      expect(destinations).toEqual({
        "Page.1": [{ num: 1, gen: 0 }, { name: "XYZ" }, 0, 375, null],
        "Page.2": [{ num: 6, gen: 0 }, { name: "XYZ" }, 0, 375, null],
      });

      await loadingTask.destroy();
    });

    it("gets a destination, from /Names (NameTree) dictionary", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue6204.pdf"));
      const pdfDoc = await loadingTask.promise;
      const destination = await pdfDoc.getDestination("Page.1");
      expect(destination).toEqual([
        { num: 1, gen: 0 },
        { name: "XYZ" },
        0,
        375,
        null,
      ]);

      await loadingTask.destroy();
    });

    it("gets a non-existent destination, from /Names (NameTree) dictionary", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue6204.pdf"));
      const pdfDoc = await loadingTask.promise;
      const destination = await pdfDoc.getDestination(
        "non-existent-named-destination"
      );
      expect(destination).toEqual(null);

      await loadingTask.destroy();
    });

    it("gets a destination, from out-of-order /Names (NameTree) dictionary (issue 10272)", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }
      const loadingTask = getDocument(buildGetDocumentParams("issue10272.pdf"));
      const pdfDoc = await loadingTask.promise;
      const destination = await pdfDoc.getDestination("link_1");
      expect(destination).toEqual([
        { num: 17, gen: 0 },
        { name: "XYZ" },
        69,
        125,
        0,
      ]);

      await loadingTask.destroy();
    });

    it("gets a destination, from /Names (NameTree) dictionary with keys using PDFDocEncoding (issue 14847)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue14847.pdf"));
      const pdfDoc = await loadingTask.promise;
      const destination = await pdfDoc.getDestination("index");
      expect(destination).toEqual([
        { num: 10, gen: 0 },
        { name: "XYZ" },
        85.039,
        728.504,
        null,
      ]);

      await loadingTask.destroy();
    });

    it("gets non-string destination", async function () {
      let numberPromise = pdfDocument.getDestination(4.3);
      let booleanPromise = pdfDocument.getDestination(true);
      let arrayPromise = pdfDocument.getDestination([
        { num: 17, gen: 0 },
        { name: "XYZ" },
        0,
        841.89,
        null,
      ]);

      numberPromise = numberPromise.then(
        function () {
          throw new Error("shall fail for non-string destination.");
        },
        function (reason) {
          expect(reason instanceof Error).toEqual(true);
        }
      );
      booleanPromise = booleanPromise.then(
        function () {
          throw new Error("shall fail for non-string destination.");
        },
        function (reason) {
          expect(reason instanceof Error).toEqual(true);
        }
      );
      arrayPromise = arrayPromise.then(
        function () {
          throw new Error("shall fail for non-string destination.");
        },
        function (reason) {
          expect(reason instanceof Error).toEqual(true);
        }
      );

      await Promise.all([numberPromise, booleanPromise, arrayPromise]);
    });

    it("gets non-existent page labels", async function () {
      const pageLabels = await pdfDocument.getPageLabels();
      expect(pageLabels).toEqual(null);
    });

    it("gets page labels", async function () {
      // PageLabels with Roman/Arabic numerals.
      const loadingTask0 = getDocument(buildGetDocumentParams("bug793632.pdf"));
      const promise0 = loadingTask0.promise.then(function (pdfDoc) {
        return pdfDoc.getPageLabels();
      });

      // PageLabels with only a label prefix.
      const loadingTask1 = getDocument(buildGetDocumentParams("issue1453.pdf"));
      const promise1 = loadingTask1.promise.then(function (pdfDoc) {
        return pdfDoc.getPageLabels();
      });

      // PageLabels identical to standard page numbering.
      const loadingTask2 = getDocument(buildGetDocumentParams("rotation.pdf"));
      const promise2 = loadingTask2.promise.then(function (pdfDoc) {
        return pdfDoc.getPageLabels();
      });

      // PageLabels with bad "Prefix" entries.
      const loadingTask3 = getDocument(
        buildGetDocumentParams("bad-PageLabels.pdf")
      );
      const promise3 = loadingTask3.promise.then(function (pdfDoc) {
        return pdfDoc.getPageLabels();
      });

      const pageLabels = await Promise.all([
        promise0,
        promise1,
        promise2,
        promise3,
      ]);
      expect(pageLabels[0]).toEqual(["i", "ii", "iii", "1"]);
      expect(pageLabels[1]).toEqual(["Front Page1"]);
      expect(pageLabels[2]).toEqual(["1", "2"]);
      expect(pageLabels[3]).toEqual(["X3"]);

      await Promise.all([
        loadingTask0.destroy(),
        loadingTask1.destroy(),
        loadingTask2.destroy(),
        loadingTask3.destroy(),
      ]);
    });

    it("gets default page layout", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("tracemonkey.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pageLayout = await pdfDoc.getPageLayout();
      expect(pageLayout).toEqual("");

      await loadingTask.destroy();
    });

    it("gets non-default page layout", async function () {
      const pageLayout = await pdfDocument.getPageLayout();
      expect(pageLayout).toEqual("SinglePage");
    });

    it("gets default page mode", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("tracemonkey.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pageMode = await pdfDoc.getPageMode();
      expect(pageMode).toEqual("UseNone");

      await loadingTask.destroy();
    });

    it("gets non-default page mode", async function () {
      const pageMode = await pdfDocument.getPageMode();
      expect(pageMode).toEqual("UseOutlines");
    });

    it("gets default viewer preferences", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("tracemonkey.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const prefs = await pdfDoc.getViewerPreferences();
      expect(prefs).toEqual(null);

      await loadingTask.destroy();
    });

    it("gets non-default viewer preferences", async function () {
      const prefs = await pdfDocument.getViewerPreferences();
      expect(prefs).toEqual({ Direction: "L2R" });
    });

    it("gets default open action", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("tracemonkey.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const openAction = await pdfDoc.getOpenAction();
      expect(openAction).toEqual(null);

      await loadingTask.destroy();
    });

    it("gets non-default open action (with destination)", async function () {
      const openAction = await pdfDocument.getOpenAction();
      expect(openAction.dest).toEqual([
        { num: 15, gen: 0 },
        { name: "FitH" },
        null,
      ]);
      expect(openAction.action).toBeUndefined();
    });

    it("gets non-default open action (with Print action)", async function () {
      // PDF document with "Print" Named action in the OpenAction dictionary.
      const loadingTask1 = getDocument(
        buildGetDocumentParams("bug1001080.pdf")
      );
      // PDF document with "Print" Named action in the OpenAction dictionary,
      // but the OpenAction dictionary is missing the `Type` entry.
      const loadingTask2 = getDocument(
        buildGetDocumentParams("issue11442_reduced.pdf")
      );

      const promise1 = loadingTask1.promise
        .then(function (pdfDoc) {
          return pdfDoc.getOpenAction();
        })
        .then(function (openAction) {
          expect(openAction.dest).toBeUndefined();
          expect(openAction.action).toEqual("Print");

          return loadingTask1.destroy();
        });
      const promise2 = loadingTask2.promise
        .then(function (pdfDoc) {
          return pdfDoc.getOpenAction();
        })
        .then(function (openAction) {
          expect(openAction.dest).toBeUndefined();
          expect(openAction.action).toEqual("Print");

          return loadingTask2.destroy();
        });

      await Promise.all([promise1, promise2]);
    });

    it("gets non-existent attachments", async function () {
      const attachments = await pdfDocument.getAttachments();
      expect(attachments).toEqual(null);
    });

    it("gets attachments", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("attachment.pdf"));
      const pdfDoc = await loadingTask.promise;
      const attachments = await pdfDoc.getAttachments();

      const attachment = attachments["foo.txt"];
      expect(attachment.filename).toEqual("foo.txt");
      expect(attachment.content).toEqual(
        new Uint8Array([98, 97, 114, 32, 98, 97, 122, 32, 10])
      );

      await loadingTask.destroy();
    });

    it("gets javascript", async function () {
      const javascript = await pdfDocument.getJavaScript();
      expect(javascript).toEqual(null);
    });

    it("gets javascript with printing instructions (JS action)", async function () {
      // PDF document with "JavaScript" action in the OpenAction dictionary.
      const loadingTask = getDocument(buildGetDocumentParams("issue6106.pdf"));
      const pdfDoc = await loadingTask.promise;
      const javascript = await pdfDoc.getJavaScript();

      expect(javascript).toEqual([
        "this.print({bUI:true,bSilent:false,bShrinkToFit:true});",
      ]);
      expect(javascript[0]).toMatch(AutoPrintRegExp);

      await loadingTask.destroy();
    });

    it("gets hasJSActions, in document without javaScript", async function () {
      const hasJSActions = await pdfDocument.hasJSActions();

      expect(hasJSActions).toEqual(false);
    });

    it("gets hasJSActions, in document with javaScript", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("doc_actions.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const hasJSActions = await pdfDoc.hasJSActions();

      expect(hasJSActions).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets non-existent JSActions", async function () {
      const jsActions = await pdfDocument.getJSActions();
      expect(jsActions).toEqual(null);
    });

    it("gets JSActions", async function () {
      // PDF document with "JavaScript" action in the OpenAction dictionary.
      const loadingTask = getDocument(
        buildGetDocumentParams("doc_actions.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const docActions = await pdfDoc.getJSActions();
      const page1 = await pdfDoc.getPage(1);
      const page1Actions = await page1.getJSActions();
      const page3 = await pdfDoc.getPage(3);
      const page3Actions = await page3.getJSActions();

      expect(docActions).toEqual({
        DidPrint: [`this.getField("Text2").value = "DidPrint";`],
        DidSave: [`this.getField("Text2").value = "DidSave";`],
        WillClose: [`this.getField("Text1").value = "WillClose";`],
        WillPrint: [`this.getField("Text1").value = "WillPrint";`],
        WillSave: [`this.getField("Text1").value = "WillSave";`],
      });
      expect(page1Actions).toEqual({
        PageOpen: [`this.getField("Text1").value = "PageOpen 1";`],
        PageClose: [`this.getField("Text2").value = "PageClose 1";`],
      });
      expect(page3Actions).toEqual({
        PageOpen: [`this.getField("Text5").value = "PageOpen 3";`],
        PageClose: [`this.getField("Text6").value = "PageClose 3";`],
      });

      await loadingTask.destroy();
    });

    it("gets non-existent fieldObjects", async function () {
      const fieldObjects = await pdfDocument.getFieldObjects();
      expect(fieldObjects).toEqual(null);
    });

    it("gets fieldObjects", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("js-authors.pdf"));
      const pdfDoc = await loadingTask.promise;
      const fieldObjects = await pdfDoc.getFieldObjects();

      expect(fieldObjects).toEqual({
        Text1: [
          {
            id: "25R",
            value: "",
            defaultValue: "",
            multiline: false,
            password: false,
            charLimit: 0,
            comb: false,
            editable: true,
            hidden: false,
            name: "Text1",
            rect: [24.1789, 719.66, 432.22, 741.66],
            actions: null,
            page: 0,
            strokeColor: null,
            fillColor: null,
            rotation: 0,
            type: "text",
          },
        ],
        Button1: [
          {
            id: "26R",
            value: "Off",
            defaultValue: null,
            exportValues: undefined,
            editable: true,
            name: "Button1",
            rect: [455.436, 719.678, 527.436, 739.678],
            hidden: false,
            actions: {
              Action: [
                `this.getField("Text1").value = this.info.authors.join("::");`,
              ],
            },
            page: 0,
            strokeColor: null,
            fillColor: new Uint8ClampedArray([192, 192, 192]),
            rotation: 0,
            type: "button",
          },
        ],
      });

      await loadingTask.destroy();
    });

    it("gets non-existent calculationOrder", async function () {
      const calculationOrder = await pdfDocument.getCalculationOrderIds();
      expect(calculationOrder).toEqual(null);
    });

    it("gets calculationOrder", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }
      const loadingTask = getDocument(buildGetDocumentParams("issue13132.pdf"));
      const pdfDoc = await loadingTask.promise;
      const calculationOrder = await pdfDoc.getCalculationOrderIds();

      expect(calculationOrder).toEqual([
        "319R",
        "320R",
        "321R",
        "322R",
        "323R",
        "324R",
        "325R",
        "326R",
        "327R",
        "328R",
        "329R",
        "330R",
        "331R",
        "332R",
        "333R",
        "334R",
        "335R",
      ]);

      await loadingTask.destroy();
    });

    it("gets non-existent outline", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("tracemonkey.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const outline = await pdfDoc.getOutline();
      expect(outline).toEqual(null);

      await loadingTask.destroy();
    });

    it("gets outline", async function () {
      const outline = await pdfDocument.getOutline();

      // Two top level entries.
      expect(Array.isArray(outline)).toEqual(true);
      expect(outline.length).toEqual(2);

      // Make sure some basic attributes are set.
      const outlineItem = outline[1];
      expect(outlineItem.title).toEqual("Chapter 1");
      expect(Array.isArray(outlineItem.dest)).toEqual(true);
      expect(outlineItem.url).toEqual(null);
      expect(outlineItem.unsafeUrl).toBeUndefined();
      expect(outlineItem.newWindow).toBeUndefined();

      expect(outlineItem.bold).toEqual(true);
      expect(outlineItem.italic).toEqual(false);
      expect(outlineItem.color).toEqual(new Uint8ClampedArray([0, 64, 128]));

      expect(outlineItem.items.length).toEqual(1);
      expect(outlineItem.items[0].title).toEqual("Paragraph 1.1");
    });

    it("gets outline containing a URL", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue3214.pdf"));
      const pdfDoc = await loadingTask.promise;
      const outline = await pdfDoc.getOutline();
      expect(Array.isArray(outline)).toEqual(true);
      expect(outline.length).toEqual(5);

      const outlineItemTwo = outline[2];
      expect(typeof outlineItemTwo.title).toEqual("string");
      expect(outlineItemTwo.dest).toEqual(null);
      expect(outlineItemTwo.url).toEqual("http://google.com/");
      expect(outlineItemTwo.unsafeUrl).toEqual("http://google.com");
      expect(outlineItemTwo.newWindow).toBeUndefined();

      const outlineItemOne = outline[1];
      expect(outlineItemOne.bold).toEqual(false);
      expect(outlineItemOne.italic).toEqual(true);
      expect(outlineItemOne.color).toEqual(new Uint8ClampedArray([0, 0, 0]));

      await loadingTask.destroy();
    });

    it("gets outline, with dest-strings using PDFDocEncoding (issue 14864)", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }
      const loadingTask = getDocument(buildGetDocumentParams("issue14864.pdf"));
      const pdfDoc = await loadingTask.promise;
      const outline = await pdfDoc.getOutline();

      expect(Array.isArray(outline)).toEqual(true);
      expect(outline.length).toEqual(6);

      expect(outline[4]).toEqual({
        action: null,
        attachment: undefined,
        dest: "Händel -- Halle🎆lujah",
        url: null,
        unsafeUrl: undefined,
        newWindow: undefined,
        setOCGState: undefined,
        title: "Händel -- Halle🎆lujah",
        color: new Uint8ClampedArray([0, 0, 0]),
        count: undefined,
        bold: false,
        italic: false,
        items: [],
      });

      await loadingTask.destroy();
    });

    it("gets outline, with named-actions (issue 15367)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue15367.pdf"));
      const pdfDoc = await loadingTask.promise;
      const outline = await pdfDoc.getOutline();

      expect(Array.isArray(outline)).toEqual(true);
      expect(outline.length).toEqual(4);

      expect(outline[1]).toEqual({
        action: "PrevPage",
        attachment: undefined,
        dest: null,
        url: null,
        unsafeUrl: undefined,
        newWindow: undefined,
        setOCGState: undefined,
        title: "Previous Page",
        color: new Uint8ClampedArray([0, 0, 0]),
        count: undefined,
        bold: false,
        italic: false,
        items: [],
      });

      await loadingTask.destroy();
    });

    it("gets outline, with SetOCGState-actions (issue 15372)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue15372.pdf"));
      const pdfDoc = await loadingTask.promise;
      const outline = await pdfDoc.getOutline();

      expect(Array.isArray(outline)).toEqual(true);
      expect(outline.length).toEqual(1);

      expect(outline[0]).toEqual({
        action: null,
        attachment: undefined,
        dest: null,
        url: null,
        unsafeUrl: undefined,
        newWindow: undefined,
        setOCGState: { state: ["OFF", "ON", "50R"], preserveRB: false },
        title: "Display Layer",
        color: new Uint8ClampedArray([0, 0, 0]),
        count: undefined,
        bold: false,
        italic: false,
        items: [],
      });

      await loadingTask.destroy();
    });

    it("gets outline with non-displayable chars", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue14267.pdf"));
      const pdfDoc = await loadingTask.promise;
      const outline = await pdfDoc.getOutline();
      expect(Array.isArray(outline)).toEqual(true);
      expect(outline.length).toEqual(1);

      const outlineItem = outline[0];
      expect(outlineItem.title).toEqual("hello\x11world");

      await loadingTask.destroy();
    });

    it("gets non-existent permissions", async function () {
      const permissions = await pdfDocument.getPermissions();
      expect(permissions).toEqual(null);
    });

    it("gets permissions", async function () {
      // Editing not allowed.
      const loadingTask0 = getDocument(
        buildGetDocumentParams("issue9972-1.pdf")
      );
      const promise0 = loadingTask0.promise.then(function (pdfDoc) {
        return pdfDoc.getPermissions();
      });

      // Printing not allowed.
      const loadingTask1 = getDocument(
        buildGetDocumentParams("issue9972-2.pdf")
      );
      const promise1 = loadingTask1.promise.then(function (pdfDoc) {
        return pdfDoc.getPermissions();
      });

      // Copying not allowed.
      const loadingTask2 = getDocument(
        buildGetDocumentParams("issue9972-3.pdf")
      );
      const promise2 = loadingTask2.promise.then(function (pdfDoc) {
        return pdfDoc.getPermissions();
      });

      const totalPermissionCount = Object.keys(PermissionFlag).length;
      const permissions = await Promise.all([promise0, promise1, promise2]);

      expect(permissions[0].length).toEqual(totalPermissionCount - 1);
      expect(
        permissions[0].includes(PermissionFlag.MODIFY_CONTENTS)
      ).toBeFalsy();

      expect(permissions[1].length).toEqual(totalPermissionCount - 2);
      expect(permissions[1].includes(PermissionFlag.PRINT)).toBeFalsy();
      expect(
        permissions[1].includes(PermissionFlag.PRINT_HIGH_QUALITY)
      ).toBeFalsy();

      expect(permissions[2].length).toEqual(totalPermissionCount - 1);
      expect(permissions[2].includes(PermissionFlag.COPY)).toBeFalsy();

      await Promise.all([
        loadingTask0.destroy(),
        loadingTask1.destroy(),
        loadingTask2.destroy(),
      ]);
    });

    it("gets metadata", async function () {
      const { info, metadata, contentDispositionFilename, contentLength } =
        await pdfDocument.getMetadata();

      expect(info.Title).toEqual("Basic API Test");
      // Custom, non-standard, information dictionary entries.
      expect(info.Custom).toEqual(undefined);
      // The following are PDF.js specific, non-standard, properties.
      expect(info.PDFFormatVersion).toEqual("1.7");
      expect(info.Language).toEqual("en");
      expect(info.EncryptFilterName).toEqual(null);
      expect(info.IsLinearized).toEqual(false);
      expect(info.IsAcroFormPresent).toEqual(false);
      expect(info.IsXFAPresent).toEqual(false);
      expect(info.IsCollectionPresent).toEqual(false);
      expect(info.IsSignaturesPresent).toEqual(false);

      expect(metadata instanceof Metadata).toEqual(true);
      expect(metadata.get("dc:title")).toEqual("Basic API Test");

      expect(contentDispositionFilename).toEqual(null);
      expect(contentLength).toEqual(basicApiFileLength);
    });

    it("gets metadata, with custom info dict entries", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("tracemonkey.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const { info, metadata, contentDispositionFilename, contentLength } =
        await pdfDoc.getMetadata();

      expect(info.Creator).toEqual("TeX");
      expect(info.Producer).toEqual("pdfeTeX-1.21a");
      expect(info.CreationDate).toEqual("D:20090401163925-07'00'");
      // Custom, non-standard, information dictionary entries.
      const custom = info.Custom;
      expect(typeof custom === "object" && custom !== null).toEqual(true);

      expect(custom["PTEX.Fullbanner"]).toEqual(
        "This is pdfeTeX, " +
          "Version 3.141592-1.21a-2.2 (Web2C 7.5.4) kpathsea version 3.5.6"
      );
      // The following are PDF.js specific, non-standard, properties.
      expect(info.PDFFormatVersion).toEqual("1.4");
      expect(info.Language).toEqual(null);
      expect(info.EncryptFilterName).toEqual(null);
      expect(info.IsLinearized).toEqual(false);
      expect(info.IsAcroFormPresent).toEqual(false);
      expect(info.IsXFAPresent).toEqual(false);
      expect(info.IsCollectionPresent).toEqual(false);
      expect(info.IsSignaturesPresent).toEqual(false);

      expect(metadata).toEqual(null);
      expect(contentDispositionFilename).toEqual(null);
      expect(contentLength).toEqual(1016315);

      await loadingTask.destroy();
    });

    it("gets metadata, with missing PDF header (bug 1606566)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("bug1606566.pdf"));
      const pdfDoc = await loadingTask.promise;
      const { info, metadata, contentDispositionFilename, contentLength } =
        await pdfDoc.getMetadata();

      // Custom, non-standard, information dictionary entries.
      expect(info.Custom).toEqual(undefined);
      // The following are PDF.js specific, non-standard, properties.
      expect(info.PDFFormatVersion).toEqual(null);
      expect(info.Language).toEqual(null);
      expect(info.EncryptFilterName).toEqual(null);
      expect(info.IsLinearized).toEqual(false);
      expect(info.IsAcroFormPresent).toEqual(false);
      expect(info.IsXFAPresent).toEqual(false);
      expect(info.IsCollectionPresent).toEqual(false);
      expect(info.IsSignaturesPresent).toEqual(false);

      expect(metadata).toEqual(null);
      expect(contentDispositionFilename).toEqual(null);
      expect(contentLength).toEqual(624);

      await loadingTask.destroy();
    });

    it("gets metadata, with corrupt /Metadata XRef entry", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("PDFBOX-3148-2-fuzzed.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const { info, metadata, contentDispositionFilename, contentLength } =
        await pdfDoc.getMetadata();

      // Custom, non-standard, information dictionary entries.
      expect(info.Custom).toEqual(undefined);
      // The following are PDF.js specific, non-standard, properties.
      expect(info.PDFFormatVersion).toEqual("1.6");
      expect(info.Language).toEqual(null);
      expect(info.EncryptFilterName).toEqual(null);
      expect(info.IsLinearized).toEqual(false);
      expect(info.IsAcroFormPresent).toEqual(true);
      expect(info.IsXFAPresent).toEqual(false);
      expect(info.IsCollectionPresent).toEqual(false);
      expect(info.IsSignaturesPresent).toEqual(false);

      expect(metadata).toEqual(null);
      expect(contentDispositionFilename).toEqual(null);
      expect(contentLength).toEqual(244351);

      await loadingTask.destroy();
    });

    it("gets markInfo", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("annotation-line.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const markInfo = await pdfDoc.getMarkInfo();
      expect(markInfo.Marked).toEqual(true);
      expect(markInfo.UserProperties).toEqual(false);
      expect(markInfo.Suspects).toEqual(false);
    });

    it("gets data", async function () {
      const data = await pdfDocument.getData();
      expect(data instanceof Uint8Array).toEqual(true);
      expect(data.length).toEqual(basicApiFileLength);
    });

    it("gets download info", async function () {
      const downloadInfo = await pdfDocument.getDownloadInfo();
      expect(downloadInfo).toEqual({ length: basicApiFileLength });
    });

    it("cleans up document resources", async function () {
      await pdfDocument.cleanup();

      expect(true).toEqual(true);
    });

    it("checks that fingerprints are unique", async function () {
      const loadingTask1 = getDocument(
        buildGetDocumentParams("issue4436r.pdf")
      );
      const loadingTask2 = getDocument(buildGetDocumentParams("issue4575.pdf"));

      const data = await Promise.all([
        loadingTask1.promise,
        loadingTask2.promise,
      ]);
      const fingerprints1 = data[0].fingerprints;
      const fingerprints2 = data[1].fingerprints;

      expect(fingerprints1).not.toEqual(fingerprints2);

      expect(fingerprints1).toEqual(["657428c0628e329f9a281fb6d2d092d4", null]);
      expect(fingerprints2).toEqual(["04c7126b34a46b6d4d6e7a1eff7edcb6", null]);

      await Promise.all([loadingTask1.destroy(), loadingTask2.destroy()]);
    });

    it("write a value in an annotation, save the pdf and load it", async function () {
      let loadingTask = getDocument(buildGetDocumentParams("evaljs.pdf"));
      let pdfDoc = await loadingTask.promise;
      const value = "Hello World";

      pdfDoc.annotationStorage.setValue("55R", { value });

      const data = await pdfDoc.saveDocument();
      await loadingTask.destroy();

      loadingTask = getDocument(data);
      pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const annotations = await pdfPage.getAnnotations();

      const field = annotations.find(annotation => annotation.id === "55R");
      expect(!!field).toEqual(true);
      expect(field.fieldValue).toEqual(value);

      await loadingTask.destroy();
    });

    it("write a value in an annotation, save the pdf and check the value in xfa datasets (1)", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }

      let loadingTask = getDocument(buildGetDocumentParams("issue16081.pdf"));
      let pdfDoc = await loadingTask.promise;
      const value = "Hello World";

      pdfDoc.annotationStorage.setValue("2055R", { value });

      const data = await pdfDoc.saveDocument();
      await loadingTask.destroy();

      loadingTask = getDocument(data);
      pdfDoc = await loadingTask.promise;
      const datasets = await pdfDoc.getXFADatasets();

      const surName = getNamedNodeInXML(
        datasets.node,
        "xfa:data.PPTC_153.Page1.PersonalInformation.TitleAndNameInformation.PersonalInfo.Surname.#text"
      );
      expect(surName.nodeValue).toEqual(value);

      await loadingTask.destroy();
    });

    it("write a value in an annotation, save the pdf and check the value in xfa datasets (2)", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }

      // In this file the path to the fields are wrong but the last path element
      // is unique so we can guess what the node is.
      let loadingTask = getDocument(buildGetDocumentParams("f1040_2022.pdf"));
      let pdfDoc = await loadingTask.promise;

      pdfDoc.annotationStorage.setValue("1573R", { value: "hello" });
      pdfDoc.annotationStorage.setValue("1577R", { value: "world" });

      const data = await pdfDoc.saveDocument();
      await loadingTask.destroy();

      loadingTask = getDocument(data);
      pdfDoc = await loadingTask.promise;
      const datasets = await pdfDoc.getXFADatasets();

      const firstName = getNamedNodeInXML(
        datasets.node,
        "xfa:data.topmostSubform.f1_02.#text"
      );
      expect(firstName.nodeValue).toEqual("hello");

      const lastName = getNamedNodeInXML(
        datasets.node,
        "xfa:data.topmostSubform.f1_06.#text"
      );
      expect(lastName.nodeValue).toEqual("world");

      await loadingTask.destroy();
    });

    describe("Cross-origin", function () {
      let loadingTask;
      function _checkCanLoad(expectSuccess, filename, options) {
        if (isNodeJS) {
          pending("Cannot simulate cross-origin requests in Node.js");
        }
        const params = buildGetDocumentParams(filename, options);
        const url = new URL(params.url);
        if (url.hostname === "localhost") {
          url.hostname = "127.0.0.1";
        } else if (params.url.hostname === "127.0.0.1") {
          url.hostname = "localhost";
        } else {
          pending("Can only run cross-origin test on localhost!");
        }
        params.url = url.href;
        loadingTask = getDocument(params);
        return loadingTask.promise
          .then(function (pdf) {
            return pdf.destroy();
          })
          .then(
            function () {
              expect(expectSuccess).toEqual(true);
            },
            function (error) {
              if (expectSuccess) {
                // For ease of debugging.
                expect(error).toEqual("There should not be any error");
              }
              expect(expectSuccess).toEqual(false);
            }
          );
      }
      function testCanLoad(filename, options) {
        return _checkCanLoad(true, filename, options);
      }
      function testCannotLoad(filename, options) {
        return _checkCanLoad(false, filename, options);
      }

      afterEach(async function () {
        if (loadingTask && !loadingTask.destroyed) {
          await loadingTask.destroy();
        }
      });

      it("server disallows cors", async function () {
        await testCannotLoad("basicapi.pdf");
      });

      it("server allows cors without credentials, default withCredentials", async function () {
        await testCanLoad("basicapi.pdf?cors=withoutCredentials");
      });

      it("server allows cors without credentials, and withCredentials=false", async function () {
        await testCanLoad("basicapi.pdf?cors=withoutCredentials", {
          withCredentials: false,
        });
      });

      it("server allows cors without credentials, but withCredentials=true", async function () {
        await testCannotLoad("basicapi.pdf?cors=withoutCredentials", {
          withCredentials: true,
        });
      });

      it("server allows cors with credentials, and withCredentials=true", async function () {
        await testCanLoad("basicapi.pdf?cors=withCredentials", {
          withCredentials: true,
        });
      });

      it("server allows cors with credentials, and withCredentials=false", async function () {
        // The server supports even more than we need, so if the previous tests
        // pass, then this should pass for sure.
        // The only case where this test fails is when the server does not reply
        // with the Access-Control-Allow-Origin header.
        await testCanLoad("basicapi.pdf?cors=withCredentials", {
          withCredentials: false,
        });
      });
    });
  });

  describe("Page", function () {
    let pdfLoadingTask, pdfDocument, page;

    beforeAll(async function () {
      pdfLoadingTask = getDocument(basicApiGetDocumentParams);
      pdfDocument = await pdfLoadingTask.promise;
      page = await pdfDocument.getPage(1);
    });

    afterAll(async function () {
      await pdfLoadingTask.destroy();
    });

    it("gets page number", function () {
      expect(page.pageNumber).toEqual(1);
    });

    it("gets rotate", function () {
      expect(page.rotate).toEqual(0);
    });

    it("gets ref", function () {
      expect(page.ref).toEqual({ num: 15, gen: 0 });
    });

    it("gets userUnit", function () {
      expect(page.userUnit).toEqual(1.0);
    });

    it("gets view", function () {
      expect(page.view).toEqual([0, 0, 595.28, 841.89]);
    });

    it("gets view, with empty/invalid bounding boxes", async function () {
      const viewLoadingTask = getDocument(
        buildGetDocumentParams("boundingBox_invalid.pdf")
      );

      const pdfDoc = await viewLoadingTask.promise;
      const numPages = pdfDoc.numPages;
      expect(numPages).toEqual(3);

      const viewPromises = [];
      for (let i = 0; i < numPages; i++) {
        viewPromises[i] = pdfDoc.getPage(i + 1).then(pdfPage => {
          return pdfPage.view;
        });
      }

      const [page1, page2, page3] = await Promise.all(viewPromises);
      expect(page1).toEqual([0, 0, 612, 792]);
      expect(page2).toEqual([0, 0, 800, 600]);
      expect(page3).toEqual([0, 0, 600, 800]);

      await viewLoadingTask.destroy();
    });

    it("gets viewport", function () {
      const viewport = page.getViewport({ scale: 1.5, rotation: 90 });
      expect(viewport instanceof PageViewport).toEqual(true);

      expect(viewport.viewBox).toEqual(page.view);
      expect(viewport.scale).toEqual(1.5);
      expect(viewport.rotation).toEqual(90);
      expect(viewport.transform).toEqual([0, 1.5, 1.5, 0, 0, 0]);
      expect(viewport.width).toEqual(1262.835);
      expect(viewport.height).toEqual(892.92);
    });

    it('gets viewport with "offsetX/offsetY" arguments', function () {
      const viewport = page.getViewport({
        scale: 1,
        rotation: 0,
        offsetX: 100,
        offsetY: -100,
      });
      expect(viewport instanceof PageViewport).toEqual(true);

      expect(viewport.transform).toEqual([1, 0, 0, -1, 100, 741.89]);
    });

    it('gets viewport respecting "dontFlip" argument', function () {
      const scale = 1,
        rotation = 0;
      const viewport = page.getViewport({ scale, rotation });
      expect(viewport instanceof PageViewport).toEqual(true);

      const dontFlipViewport = page.getViewport({
        scale,
        rotation,
        dontFlip: true,
      });
      expect(dontFlipViewport instanceof PageViewport).toEqual(true);

      expect(dontFlipViewport).not.toEqual(viewport);
      expect(dontFlipViewport).toEqual(viewport.clone({ dontFlip: true }));

      expect(viewport.transform).toEqual([1, 0, 0, -1, 0, 841.89]);
      expect(dontFlipViewport.transform).toEqual([1, 0, -0, 1, 0, 0]);
    });

    it("gets viewport with invalid rotation", function () {
      expect(function () {
        page.getViewport({ scale: 1, rotation: 45 });
      }).toThrow(
        new Error(
          "PageViewport: Invalid rotation, must be a multiple of 90 degrees."
        )
      );
    });

    it("gets annotations", async function () {
      const defaultPromise = page.getAnnotations().then(function (data) {
        expect(data.length).toEqual(4);
      });

      const anyPromise = page
        .getAnnotations({ intent: "any" })
        .then(function (data) {
          expect(data.length).toEqual(4);
        });

      const displayPromise = page
        .getAnnotations({ intent: "display" })
        .then(function (data) {
          expect(data.length).toEqual(4);
        });

      const printPromise = page
        .getAnnotations({ intent: "print" })
        .then(function (data) {
          expect(data.length).toEqual(4);
        });

      await Promise.all([
        defaultPromise,
        anyPromise,
        displayPromise,
        printPromise,
      ]);
    });

    it("gets annotations containing relative URLs (bug 766086)", async function () {
      const filename = "bug766086.pdf";

      const defaultLoadingTask = getDocument(buildGetDocumentParams(filename));
      const defaultPromise = defaultLoadingTask.promise.then(function (pdfDoc) {
        return pdfDoc.getPage(1).then(function (pdfPage) {
          return pdfPage.getAnnotations();
        });
      });

      const docBaseUrlLoadingTask = getDocument(
        buildGetDocumentParams(filename, {
          docBaseUrl: "http://www.example.com/test/pdfs/qwerty.pdf",
        })
      );
      const docBaseUrlPromise = docBaseUrlLoadingTask.promise.then(function (
        pdfDoc
      ) {
        return pdfDoc.getPage(1).then(function (pdfPage) {
          return pdfPage.getAnnotations();
        });
      });

      const invalidDocBaseUrlLoadingTask = getDocument(
        buildGetDocumentParams(filename, {
          docBaseUrl: "qwerty.pdf",
        })
      );
      const invalidDocBaseUrlPromise =
        invalidDocBaseUrlLoadingTask.promise.then(function (pdfDoc) {
          return pdfDoc.getPage(1).then(function (pdfPage) {
            return pdfPage.getAnnotations();
          });
        });

      const [
        defaultAnnotations,
        docBaseUrlAnnotations,
        invalidDocBaseUrlAnnotations,
      ] = await Promise.all([
        defaultPromise,
        docBaseUrlPromise,
        invalidDocBaseUrlPromise,
      ]);

      expect(defaultAnnotations[0].url).toBeUndefined();
      expect(defaultAnnotations[0].unsafeUrl).toEqual(
        "../../0021/002156/215675E.pdf#15"
      );

      expect(docBaseUrlAnnotations[0].url).toEqual(
        "http://www.example.com/0021/002156/215675E.pdf#15"
      );
      expect(docBaseUrlAnnotations[0].unsafeUrl).toEqual(
        "../../0021/002156/215675E.pdf#15"
      );

      expect(invalidDocBaseUrlAnnotations[0].url).toBeUndefined();
      expect(invalidDocBaseUrlAnnotations[0].unsafeUrl).toEqual(
        "../../0021/002156/215675E.pdf#15"
      );

      await Promise.all([
        defaultLoadingTask.destroy(),
        docBaseUrlLoadingTask.destroy(),
        invalidDocBaseUrlLoadingTask.destroy(),
      ]);
    });

    it("gets annotations containing GoToE action (issue 8844)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue8844.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const annotations = await pdfPage.getAnnotations();

      expect(annotations.length).toEqual(1);
      expect(annotations[0].annotationType).toEqual(AnnotationType.LINK);

      const { filename, content } = annotations[0].attachment;
      expect(filename).toEqual("man.pdf");
      expect(content instanceof Uint8Array).toEqual(true);
      expect(content.length).toEqual(4508);

      await loadingTask.destroy();
    });

    it("gets text content", async function () {
      const defaultPromise = page.getTextContent();
      const parametersPromise = page.getTextContent({
        disableCombineTextItems: true,
      });

      const data = await Promise.all([defaultPromise, parametersPromise]);

      expect(!!data[0].items).toEqual(true);
      expect(data[0].items.length).toEqual(15);
      expect(!!data[0].styles).toEqual(true);

      const page1 = mergeText(data[0].items);
      expect(page1).toEqual(`Table Of Content
Chapter 1 .......................................................... 2
Paragraph 1.1 ...................................................... 3
page 1 / 3`);

      expect(!!data[1].items).toEqual(true);
      expect(data[1].items.length).toEqual(6);
      expect(!!data[1].styles).toEqual(true);
    });

    it("gets text content, with correct properties (issue 8276)", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("issue8276_reduced.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items, styles } = await pdfPage.getTextContent();
      expect(items.length).toEqual(1);
      // Font name will be a random object id.
      const fontName = items[0].fontName;
      expect(Object.keys(styles)).toEqual([fontName]);

      expect(items[0]).toEqual({
        dir: "ltr",
        fontName,
        height: 18,
        str: "Issue 8276",
        transform: [18, 0, 0, 18, 441.81, 708.4499999999999],
        width: 77.49,
        hasEOL: false,
      });
      expect(styles[fontName]).toEqual({
        fontFamily: "serif",
        // `useSystemFonts` has a different value in web environments
        // and in Node.js.
        ascent: isNodeJS ? NaN : 0.683,
        descent: isNodeJS ? NaN : -0.217,
        vertical: false,
      });

      // Wait for font data to be loaded so we can check that the font names
      // match.
      await pdfPage.getOperatorList();
      expect(pdfPage.commonObjs.has(fontName)).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets text content, with no extra spaces (issue 13226)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue13226.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(text).toEqual(
        "Mitarbeiterinnen und Mitarbeiter arbeiten in über 100 Ländern engagiert im Dienste"
      );

      await loadingTask.destroy();
    });

    it("gets text content, with merged spaces (issue 13201)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue13201.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(
        text.includes(
          "Abstract. A purely peer-to-peer version of electronic cash would allow online"
        )
      ).toEqual(true);
      expect(
        text.includes(
          "avoid mediating disputes. The cost of mediation increases transaction costs, limiting the"
        )
      ).toEqual(true);
      expect(
        text.includes(
          "system is secure as long as honest nodes collectively control more CPU power than any"
        )
      ).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets text content, with no spaces between letters of words (issue 11913)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue11913.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(
        text.includes(
          "1. The first of these cases arises from the tragic handicap which has blighted the life of the Plaintiff, and from the response of the"
        )
      ).toEqual(true);
      expect(
        text.includes(
          "argued in this Court the appeal raises narrower, but important, issues which may be summarised as follows:-"
        )
      ).toEqual(true);
      await loadingTask.destroy();
    });

    it("gets text content, with merged spaces (issue 10900)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue10900.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(
        text.includes(`3 3 3 3
851.5 854.9 839.3 837.5
633.6 727.8 789.9 796.2
1,485.1 1,582.7 1,629.2 1,633.7
114.2 121.7 125.3 130.7
13.0x 13.0x 13.0x 12.5x`)
      ).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets text content, with spaces (issue 10640)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("issue10640.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(
        text.includes(`Open Sans is a humanist sans serif typeface designed by Steve Matteson.
Open Sans was designed with an upright stress, open forms and a neu-
tral, yet friendly appearance. It was optimized for print, web, and mobile
interfaces, and has excellent legibility characteristics in its letterforms (see
figure \x81 on the following page). This font is available from the Google Font
Directory [\x81] as TrueType files licensed under the Apache License version \x82.\x80.
This package provides support for this font in LATEX. It includes Type \x81
versions of the fonts, converted for this package using FontForge from its
sources, for full support with Dvips.`)
      ).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets text content, with negative spaces (bug 931481)", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }

      const loadingTask = getDocument(buildGetDocumentParams("bug931481.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(
        text.includes(`Kathrin Nachbaur
Die promovierte Juristin ist 1979 in Graz geboren und aufgewachsen. Nach
erfolgreichem Studienabschluss mit Fokus auf Europarecht absolvierte sie ein
Praktikum bei Magna International in Kanada in der Human Resources Abteilung.
Anschliessend wurde sie geschult in Human Resources, Arbeitsrecht und
Kommunikation, währenddessen sie auch an ihrem Doktorat im Wirtschaftsrecht
arbeitete. Seither arbeitete sie bei Magna International als Projekt Manager in der
Innovationsabteilung. Seit 2009 ist sie Frank Stronachs Büroleiterin in Österreich und
Kanada. Zusätzlich ist sie seit 2012 Vice President, Business Development der
Stronach Group und Vizepräsidentin und Institutsleiterin des Stronach Institut für
sozialökonomische Gerechtigkeit.`)
      ).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets text content, with invisible text marks (issue 9186)", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }

      const loadingTask = getDocument(buildGetDocumentParams("issue9186.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(
        text.includes(`This Agreement (“Agreement”) is made as of this 25th day of January, 2017, by and
between EDWARD G. ATSINGER III, not individually but as sole Trustee of the ATSINGER
FAMILY TRUST /u/a dated October 31, 1980 as amended, and STUART W. EPPERSON, not
individually but solely as Trustee of the STUART W. EPPERSON REVOCABLE LIVING
TRUST /u/a dated January 14th 1993 as amended, collectively referred to herein as “Lessor”, and
Caron Broadcasting, Inc., an Ohio corporation (“Lessee”).`)
      ).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets text content, with beginbfrange operator handled correctly (bug 1627427)", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("bug1627427_reduced.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(text).toEqual(
        "침하게 흐린 품이 눈이 올 듯하더니 눈은 아니 오고 얼다가 만 비가 추"
      );

      await loadingTask.destroy();
    });

    it("gets text content, and check that out-of-page text is not present (bug 1755201)", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }

      const loadingTask = getDocument(buildGetDocumentParams("bug1755201.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(6);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(/win aisle/.test(text)).toEqual(false);

      await loadingTask.destroy();
    });

    it("gets text content with or without includeMarkedContent, and compare (issue 15094)", async function () {
      if (isNodeJS) {
        pending("Linked test-cases are not supported in Node.js.");
      }

      const loadingTask = getDocument(buildGetDocumentParams("pdf.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(568);
      let { items } = await pdfPage.getTextContent({
        includeMarkedContent: false,
      });
      const textWithoutMC = mergeText(items);
      ({ items } = await pdfPage.getTextContent({
        includeMarkedContent: true,
      }));
      const textWithMC = mergeText(items);

      expect(textWithoutMC).toEqual(textWithMC);

      await loadingTask.destroy();
    });

    // TODO: Change this to a `text` reference test instead.
    //       Currently that doesn't work, since the `XMLSerializer` fails on
    //       the ASCII "control characters" found in the text-content.
    it("gets text content with non-standard ligatures (issue issue15516)", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("issue15516_reduced.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const { items } = await pdfPage.getTextContent();
      const text = mergeText(items);

      expect(text).toEqual("ffi fi ffl ff fl \x07 \x08 Ý");

      await loadingTask.destroy();
    });

    it("gets empty structure tree", async function () {
      const tree = await page.getStructTree();

      expect(tree).toEqual(null);
    });

    it("gets simple structure tree", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("structure_simple.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const tree = await pdfPage.getStructTree();

      expect(tree).toEqual({
        role: "Root",
        children: [
          {
            role: "Document",
            lang: "en-US",
            children: [
              {
                role: "H1",
                children: [
                  {
                    role: "NonStruct",
                    children: [{ type: "content", id: "page2R_mcid0" }],
                  },
                ],
              },
              {
                role: "P",
                children: [
                  {
                    role: "NonStruct",
                    children: [{ type: "content", id: "page2R_mcid1" }],
                  },
                ],
              },
              {
                role: "H2",
                children: [
                  {
                    role: "NonStruct",
                    children: [{ type: "content", id: "page2R_mcid2" }],
                  },
                ],
              },
              {
                role: "P",
                children: [
                  {
                    role: "NonStruct",
                    children: [{ type: "content", id: "page2R_mcid3" }],
                  },
                ],
              },
            ],
          },
        ],
      });

      await loadingTask.destroy();
    });

    it("gets operator list", async function () {
      const operatorList = await page.getOperatorList();

      expect(operatorList.fnArray.length).toBeGreaterThan(100);
      expect(operatorList.argsArray.length).toBeGreaterThan(100);
      expect(operatorList.lastChunk).toEqual(true);
      expect(operatorList.separateAnnots).toEqual({
        form: false,
        canvas: false,
      });
    });

    it("gets operatorList with JPEG image (issue 4888)", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("cmykjpeg.pdf"));

      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const operatorList = await pdfPage.getOperatorList();

      const imgIndex = operatorList.fnArray.indexOf(OPS.paintImageXObject);
      const imgArgs = operatorList.argsArray[imgIndex];
      const { data } = pdfPage.objs.get(imgArgs[0]);

      expect(data instanceof Uint8ClampedArray).toEqual(true);
      expect(data.length).toEqual(90000);

      await loadingTask.destroy();
    });

    it(
      "gets operatorList, from corrupt PDF file (issue 8702), " +
        "with/without `stopAtErrors` set",
      async function () {
        const loadingTask1 = getDocument(
          buildGetDocumentParams("issue8702.pdf", {
            stopAtErrors: false, // The default value.
          })
        );
        const loadingTask2 = getDocument(
          buildGetDocumentParams("issue8702.pdf", {
            stopAtErrors: true,
          })
        );

        const result1 = loadingTask1.promise.then(pdfDoc => {
          return pdfDoc.getPage(1).then(pdfPage => {
            return pdfPage.getOperatorList().then(opList => {
              expect(opList.fnArray.length).toBeGreaterThan(100);
              expect(opList.argsArray.length).toBeGreaterThan(100);
              expect(opList.lastChunk).toEqual(true);
              expect(opList.separateAnnots).toEqual(null);

              return loadingTask1.destroy();
            });
          });
        });

        const result2 = loadingTask2.promise.then(pdfDoc => {
          return pdfDoc.getPage(1).then(pdfPage => {
            return pdfPage.getOperatorList().then(opList => {
              expect(opList.fnArray.length).toEqual(0);
              expect(opList.argsArray.length).toEqual(0);
              expect(opList.lastChunk).toEqual(true);
              expect(opList.separateAnnots).toEqual(null);

              return loadingTask2.destroy();
            });
          });
        });

        await Promise.all([result1, result2]);
      }
    );

    it("gets operator list, containing Annotation-operatorLists", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("annotation-line.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const operatorList = await pdfPage.getOperatorList();

      expect(operatorList.fnArray.length).toBeGreaterThan(20);
      expect(operatorList.argsArray.length).toBeGreaterThan(20);
      expect(operatorList.lastChunk).toEqual(true);
      expect(operatorList.separateAnnots).toEqual({
        form: false,
        canvas: false,
      });

      // The `getOperatorList` method, similar to the `render` method,
      // is supposed to include any existing Annotation-operatorLists.
      expect(operatorList.fnArray.includes(OPS.beginAnnotation)).toEqual(true);
      expect(operatorList.fnArray.includes(OPS.endAnnotation)).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets operator list, with `annotationMode`-option", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("evaljs.pdf"));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(2);

      pdfDoc.annotationStorage.setValue("30R", { value: "test" });
      pdfDoc.annotationStorage.setValue("31R", { value: true });

      const opListAnnotDisable = await pdfPage.getOperatorList({
        annotationMode: AnnotationMode.DISABLE,
      });
      expect(opListAnnotDisable.fnArray.length).toEqual(0);
      expect(opListAnnotDisable.argsArray.length).toEqual(0);
      expect(opListAnnotDisable.lastChunk).toEqual(true);
      expect(opListAnnotDisable.separateAnnots).toEqual(null);

      const opListAnnotEnable = await pdfPage.getOperatorList({
        annotationMode: AnnotationMode.ENABLE,
      });
      expect(opListAnnotEnable.fnArray.length).toBeGreaterThan(140);
      expect(opListAnnotEnable.argsArray.length).toBeGreaterThan(140);
      expect(opListAnnotEnable.lastChunk).toEqual(true);
      expect(opListAnnotEnable.separateAnnots).toEqual({
        form: false,
        canvas: true,
      });

      let firstAnnotIndex = opListAnnotEnable.fnArray.indexOf(
        OPS.beginAnnotation
      );
      let isUsingOwnCanvas = opListAnnotEnable.argsArray[firstAnnotIndex][4];
      expect(isUsingOwnCanvas).toEqual(false);

      const opListAnnotEnableForms = await pdfPage.getOperatorList({
        annotationMode: AnnotationMode.ENABLE_FORMS,
      });
      expect(opListAnnotEnableForms.fnArray.length).toBeGreaterThan(30);
      expect(opListAnnotEnableForms.argsArray.length).toBeGreaterThan(30);
      expect(opListAnnotEnableForms.lastChunk).toEqual(true);
      expect(opListAnnotEnableForms.separateAnnots).toEqual({
        form: true,
        canvas: true,
      });

      firstAnnotIndex = opListAnnotEnableForms.fnArray.indexOf(
        OPS.beginAnnotation
      );
      isUsingOwnCanvas = opListAnnotEnableForms.argsArray[firstAnnotIndex][4];
      expect(isUsingOwnCanvas).toEqual(true);

      const opListAnnotEnableStorage = await pdfPage.getOperatorList({
        annotationMode: AnnotationMode.ENABLE_STORAGE,
      });
      expect(opListAnnotEnableStorage.fnArray.length).toBeGreaterThan(170);
      expect(opListAnnotEnableStorage.argsArray.length).toBeGreaterThan(170);
      expect(opListAnnotEnableStorage.lastChunk).toEqual(true);
      expect(opListAnnotEnableStorage.separateAnnots).toEqual({
        form: false,
        canvas: true,
      });

      firstAnnotIndex = opListAnnotEnableStorage.fnArray.indexOf(
        OPS.beginAnnotation
      );
      isUsingOwnCanvas = opListAnnotEnableStorage.argsArray[firstAnnotIndex][4];
      expect(isUsingOwnCanvas).toEqual(false);

      // Sanity check to ensure that the `annotationMode` is correctly applied.
      expect(opListAnnotDisable.fnArray.length).toBeLessThan(
        opListAnnotEnableForms.fnArray.length
      );
      expect(opListAnnotEnableForms.fnArray.length).toBeLessThan(
        opListAnnotEnable.fnArray.length
      );
      expect(opListAnnotEnable.fnArray.length).toBeLessThan(
        opListAnnotEnableStorage.fnArray.length
      );

      await loadingTask.destroy();
    });

    it("gets operatorList, with page resources containing corrupt /CCITTFaxDecode data", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("poppler-90-0-fuzzed.pdf")
      );
      expect(loadingTask instanceof PDFDocumentLoadingTask).toEqual(true);

      const pdfDoc = await loadingTask.promise;
      expect(pdfDoc.numPages).toEqual(16);

      const pdfPage = await pdfDoc.getPage(6);
      expect(pdfPage instanceof PDFPageProxy).toEqual(true);

      const opList = await pdfPage.getOperatorList();
      expect(opList.fnArray.length).toBeGreaterThan(25);
      expect(opList.argsArray.length).toBeGreaterThan(25);
      expect(opList.lastChunk).toEqual(true);

      await loadingTask.destroy();
    });

    it("gets page stats after parsing page, without `pdfBug` set", async function () {
      await page.getOperatorList();
      expect(page.stats).toEqual(null);
    });

    it("gets page stats after parsing page, with `pdfBug` set", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams(basicApiFileName, { pdfBug: true })
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      await pdfPage.getOperatorList();
      const stats = pdfPage.stats;

      expect(stats instanceof StatTimer).toEqual(true);
      expect(stats.times.length).toEqual(1);

      const [statEntry] = stats.times;
      expect(statEntry.name).toEqual("Page Request");
      expect(statEntry.end - statEntry.start).toBeGreaterThanOrEqual(0);

      await loadingTask.destroy();
    });

    it("gets page stats after rendering page, with `pdfBug` set", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams(basicApiFileName, { pdfBug: true })
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const viewport = pdfPage.getViewport({ scale: 1 });
      expect(viewport instanceof PageViewport).toEqual(true);

      const canvasAndCtx = CanvasFactory.create(
        viewport.width,
        viewport.height
      );
      const renderTask = pdfPage.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
      });
      expect(renderTask instanceof RenderTask).toEqual(true);

      await renderTask.promise;
      expect(renderTask.separateAnnots).toEqual(false);

      const { stats } = pdfPage;
      expect(stats instanceof StatTimer).toEqual(true);
      expect(stats.times.length).toEqual(3);

      const [statEntryOne, statEntryTwo, statEntryThree] = stats.times;
      expect(statEntryOne.name).toEqual("Page Request");
      expect(statEntryOne.end - statEntryOne.start).toBeGreaterThanOrEqual(0);

      expect(statEntryTwo.name).toEqual("Rendering");
      expect(statEntryTwo.end - statEntryTwo.start).toBeGreaterThan(0);

      expect(statEntryThree.name).toEqual("Overall");
      expect(statEntryThree.end - statEntryThree.start).toBeGreaterThan(0);

      CanvasFactory.destroy(canvasAndCtx);
      await loadingTask.destroy();
    });

    it("cancels rendering of page", async function () {
      const viewport = page.getViewport({ scale: 1 });
      expect(viewport instanceof PageViewport).toEqual(true);

      const canvasAndCtx = CanvasFactory.create(
        viewport.width,
        viewport.height
      );
      const renderTask = page.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
      });
      expect(renderTask instanceof RenderTask).toEqual(true);

      renderTask.cancel();

      try {
        await renderTask.promise;

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof RenderingCancelledException).toEqual(true);
        expect(reason.message).toEqual("Rendering cancelled, page 1");
        expect(reason.type).toEqual("canvas");
        expect(reason.extraDelay).toEqual(0);
      }

      CanvasFactory.destroy(canvasAndCtx);
    });

    it("re-render page, using the same canvas, after cancelling rendering", async function () {
      const viewport = page.getViewport({ scale: 1 });
      expect(viewport instanceof PageViewport).toEqual(true);

      const canvasAndCtx = CanvasFactory.create(
        viewport.width,
        viewport.height
      );
      const renderTask = page.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
      });
      expect(renderTask instanceof RenderTask).toEqual(true);

      renderTask.cancel();

      try {
        await renderTask.promise;

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof RenderingCancelledException).toEqual(true);
      }

      const reRenderTask = page.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
      });
      expect(reRenderTask instanceof RenderTask).toEqual(true);

      await reRenderTask.promise;
      expect(reRenderTask.separateAnnots).toEqual(false);

      CanvasFactory.destroy(canvasAndCtx);
    });

    it("multiple render() on the same canvas", async function () {
      const optionalContentConfigPromise =
        pdfDocument.getOptionalContentConfig();

      const viewport = page.getViewport({ scale: 1 });
      expect(viewport instanceof PageViewport).toEqual(true);

      const canvasAndCtx = CanvasFactory.create(
        viewport.width,
        viewport.height
      );
      const renderTask1 = page.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
        optionalContentConfigPromise,
      });
      expect(renderTask1 instanceof RenderTask).toEqual(true);

      const renderTask2 = page.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
        optionalContentConfigPromise,
      });
      expect(renderTask2 instanceof RenderTask).toEqual(true);

      await Promise.all([
        renderTask1.promise,
        renderTask2.promise.then(
          () => {
            // Shouldn't get here.
            expect(false).toEqual(true);
          },
          reason => {
            // It fails because we are already using this canvas.
            expect(/multiple render\(\)/.test(reason.message)).toEqual(true);
          }
        ),
      ]);
    });

    it("cleans up document resources after rendering of page", async function () {
      const loadingTask = getDocument(buildGetDocumentParams(basicApiFileName));
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);

      const viewport = pdfPage.getViewport({ scale: 1 });
      expect(viewport instanceof PageViewport).toEqual(true);

      const canvasAndCtx = CanvasFactory.create(
        viewport.width,
        viewport.height
      );
      const renderTask = pdfPage.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
      });
      expect(renderTask instanceof RenderTask).toEqual(true);

      await renderTask.promise;
      expect(renderTask.separateAnnots).toEqual(false);

      await pdfDoc.cleanup();
      expect(true).toEqual(true);

      CanvasFactory.destroy(canvasAndCtx);
      await loadingTask.destroy();
    });

    it("cleans up document resources during rendering of page", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("tracemonkey.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);

      const viewport = pdfPage.getViewport({ scale: 1 });
      expect(viewport instanceof PageViewport).toEqual(true);

      const canvasAndCtx = CanvasFactory.create(
        viewport.width,
        viewport.height
      );
      const renderTask = pdfPage.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
      });
      expect(renderTask instanceof RenderTask).toEqual(true);

      // Ensure that clean-up runs during rendering.
      renderTask.onContinue = function (cont) {
        waitSome(cont);
      };

      try {
        await pdfDoc.cleanup();

        // Shouldn't get here.
        expect(false).toEqual(true);
      } catch (reason) {
        expect(reason instanceof Error).toEqual(true);
        expect(reason.message).toEqual(
          "startCleanup: Page 1 is currently rendering."
        );
      }
      await renderTask.promise;
      expect(renderTask.separateAnnots).toEqual(false);

      CanvasFactory.destroy(canvasAndCtx);
      await loadingTask.destroy();
    });

    it("caches image resources at the document/page level as expected (issue 11878)", async function () {
      const { NUM_PAGES_THRESHOLD } = GlobalImageCache,
        EXPECTED_WIDTH = 2550,
        EXPECTED_HEIGHT = 3300;

      const loadingTask = getDocument(buildGetDocumentParams("issue11878.pdf"));
      const pdfDoc = await loadingTask.promise;
      let firstImgData = null;

      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const pdfPage = await pdfDoc.getPage(i);
        const opList = await pdfPage.getOperatorList();

        const { commonObjs, objs } = pdfPage;
        const imgIndex = opList.fnArray.indexOf(OPS.paintImageXObject);
        const [objId, width, height] = opList.argsArray[imgIndex];

        if (i < NUM_PAGES_THRESHOLD) {
          expect(objId).toEqual(`img_p${i - 1}_1`);

          expect(objs.has(objId)).toEqual(true);
          expect(commonObjs.has(objId)).toEqual(false);
        } else {
          expect(objId).toEqual(
            `g_${loadingTask.docId}_img_p${NUM_PAGES_THRESHOLD - 1}_1`
          );

          expect(objs.has(objId)).toEqual(false);
          expect(commonObjs.has(objId)).toEqual(true);
        }
        expect(width).toEqual(EXPECTED_WIDTH);
        expect(height).toEqual(EXPECTED_HEIGHT);

        // Ensure that the actual image data is identical for all pages.
        if (i === 1) {
          firstImgData = objs.get(objId);

          expect(firstImgData.width).toEqual(EXPECTED_WIDTH);
          expect(firstImgData.height).toEqual(EXPECTED_HEIGHT);

          expect(firstImgData.kind).toEqual(ImageKind.RGB_24BPP);
          expect(firstImgData.data instanceof Uint8ClampedArray).toEqual(true);
          expect(firstImgData.data.length).toEqual(25245000);
        } else {
          const objsPool = i >= NUM_PAGES_THRESHOLD ? commonObjs : objs;
          const currentImgData = objsPool.get(objId);

          expect(currentImgData.width).toEqual(firstImgData.width);
          expect(currentImgData.height).toEqual(firstImgData.height);

          expect(currentImgData.kind).toEqual(firstImgData.kind);
          expect(currentImgData.data instanceof Uint8ClampedArray).toEqual(
            true
          );
          expect(
            currentImgData.data.every((value, index) => {
              return value === firstImgData.data[index];
            })
          ).toEqual(true);
        }
      }

      await loadingTask.destroy();
      firstImgData = null;
    });

    it("render for printing, with `printAnnotationStorage` set", async function () {
      async function getPrintData(printAnnotationStorage = null) {
        const canvasAndCtx = CanvasFactory.create(
          viewport.width,
          viewport.height
        );
        const renderTask = pdfPage.render({
          canvasContext: canvasAndCtx.context,
          canvasFactory: CanvasFactory,
          viewport,
          intent: "print",
          annotationMode: AnnotationMode.ENABLE_STORAGE,
          printAnnotationStorage,
        });

        await renderTask.promise;
        expect(renderTask.separateAnnots).toEqual(false);

        const printData = canvasAndCtx.canvas.toDataURL();
        CanvasFactory.destroy(canvasAndCtx);

        return printData;
      }

      const loadingTask = getDocument(
        buildGetDocumentParams("annotation-tx.pdf")
      );
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const viewport = pdfPage.getViewport({ scale: 1 });

      // Update the contents of the form-field.
      const { annotationStorage } = pdfDoc;
      annotationStorage.setValue("22R", { value: "Hello World" });

      // Render for printing, with default parameters.
      const printOriginalData = await getPrintData();

      // Get the *frozen* print-storage for use during printing.
      const printAnnotationStorage = annotationStorage.print;
      // Update the contents of the form-field again.
      annotationStorage.setValue("22R", { value: "Printing again..." });

      const annotationHash = AnnotationStorage.getHash(
        annotationStorage.serializable
      );
      const printAnnotationHash = AnnotationStorage.getHash(
        printAnnotationStorage.serializable
      );
      // Sanity check to ensure that the print-storage didn't change,
      // after the form-field was updated.
      expect(printAnnotationHash).not.toEqual(annotationHash);

      // Render for printing again, after updating the form-field,
      // with default parameters.
      const printAgainData = await getPrintData();

      // Render for printing again, after updating the form-field,
      // with `printAnnotationStorage` set.
      const printStorageData = await getPrintData(printAnnotationStorage);

      // Ensure that printing again, with default parameters,
      // actually uses the "new" form-field data.
      expect(printAgainData).not.toEqual(printOriginalData);
      // Finally ensure that printing, with `printAnnotationStorage` set,
      // still uses the "previous" form-field data.
      expect(printStorageData).toEqual(printOriginalData);

      await loadingTask.destroy();
    });
  });

  describe("Multiple `getDocument` instances", function () {
    // Regression test for https://github.com/mozilla/pdf.js/issues/6205
    // A PDF using the Helvetica font.
    const pdf1 = buildGetDocumentParams("tracemonkey.pdf");
    // A PDF using the Times font.
    const pdf2 = buildGetDocumentParams("TAMReview.pdf");
    // A PDF using the Arial font.
    const pdf3 = buildGetDocumentParams("issue6068.pdf");
    const loadingTasks = [];

    // Render the first page of the given PDF file.
    // Fulfills the promise with the base64-encoded version of the PDF.
    async function renderPDF(filename) {
      const loadingTask = getDocument(filename);
      loadingTasks.push(loadingTask);
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1.2 });
      expect(viewport instanceof PageViewport).toEqual(true);

      const canvasAndCtx = CanvasFactory.create(
        viewport.width,
        viewport.height
      );
      const renderTask = page.render({
        canvasContext: canvasAndCtx.context,
        canvasFactory: CanvasFactory,
        viewport,
      });
      await renderTask.promise;
      expect(renderTask.separateAnnots).toEqual(false);

      const data = canvasAndCtx.canvas.toDataURL();
      CanvasFactory.destroy(canvasAndCtx);
      return data;
    }

    afterEach(async function () {
      // Issue 6205 reported an issue with font rendering, so clear the loaded
      // fonts so that we can see whether loading PDFs in parallel does not
      // cause any issues with the rendered fonts.
      const destroyPromises = loadingTasks.map(function (loadingTask) {
        return loadingTask.destroy();
      });
      await Promise.all(destroyPromises);
    });

    it("should correctly render PDFs in parallel", async function () {
      let baseline1, baseline2, baseline3;
      const promiseDone = renderPDF(pdf1)
        .then(function (data1) {
          baseline1 = data1;
          return renderPDF(pdf2);
        })
        .then(function (data2) {
          baseline2 = data2;
          return renderPDF(pdf3);
        })
        .then(function (data3) {
          baseline3 = data3;
          return Promise.all([
            renderPDF(pdf1),
            renderPDF(pdf2),
            renderPDF(pdf3),
          ]);
        })
        .then(function (dataUrls) {
          expect(dataUrls[0]).toEqual(baseline1);
          expect(dataUrls[1]).toEqual(baseline2);
          expect(dataUrls[2]).toEqual(baseline3);
          return true;
        });

      await promiseDone;
    });
  });

  describe("PDFDataRangeTransport", function () {
    let dataPromise;

    beforeAll(function () {
      const fileName = "tracemonkey.pdf";
      dataPromise = DefaultFileReaderFactory.fetch({
        path: TEST_PDFS_PATH + fileName,
      });
    });

    afterAll(function () {
      dataPromise = null;
    });

    it("should fetch document info and page using ranges", async function () {
      const initialDataLength = 4000;
      const subArrays = [];
      let fetches = 0;

      const data = await dataPromise;
      const initialData = new Uint8Array(data.subarray(0, initialDataLength));
      subArrays.push(initialData);

      const transport = new PDFDataRangeTransport(data.length, initialData);
      transport.requestDataRange = function (begin, end) {
        fetches++;
        waitSome(function () {
          const chunk = new Uint8Array(data.subarray(begin, end));
          subArrays.push(chunk);

          transport.onDataProgress(initialDataLength);
          transport.onDataRange(begin, chunk);
        });
      };

      const loadingTask = getDocument({ range: transport });
      const pdfDocument = await loadingTask.promise;
      expect(pdfDocument.numPages).toEqual(14);

      const pdfPage = await pdfDocument.getPage(10);
      expect(pdfPage.rotate).toEqual(0);
      expect(fetches).toBeGreaterThan(2);

      if (!isNodeJS) {
        // Check that the TypedArrays were transferred.
        for (const array of subArrays) {
          expect(array.length).toEqual(0);
        }
      }

      await loadingTask.destroy();
    });

    it("should fetch document info and page using range and streaming", async function () {
      const initialDataLength = 4000;
      const subArrays = [];
      let fetches = 0;

      const data = await dataPromise;
      const initialData = new Uint8Array(data.subarray(0, initialDataLength));
      subArrays.push(initialData);

      const transport = new PDFDataRangeTransport(data.length, initialData);
      transport.requestDataRange = function (begin, end) {
        fetches++;
        if (fetches === 1) {
          const chunk = new Uint8Array(data.subarray(initialDataLength));
          subArrays.push(chunk);

          // Send rest of the data on first range request.
          transport.onDataProgressiveRead(chunk);
        }
        waitSome(function () {
          const chunk = new Uint8Array(data.subarray(begin, end));
          subArrays.push(chunk);

          transport.onDataRange(begin, chunk);
        });
      };

      const loadingTask = getDocument({ range: transport });
      const pdfDocument = await loadingTask.promise;
      expect(pdfDocument.numPages).toEqual(14);

      const pdfPage = await pdfDocument.getPage(10);
      expect(pdfPage.rotate).toEqual(0);
      expect(fetches).toEqual(1);

      await new Promise(resolve => {
        waitSome(resolve);
      });

      if (!isNodeJS) {
        // Check that the TypedArrays were transferred.
        for (const array of subArrays) {
          expect(array.length).toEqual(0);
        }
      }

      await loadingTask.destroy();
    });

    it(
      "should fetch document info and page, without range, " +
        "using complete initialData",
      async function () {
        const subArrays = [];
        let fetches = 0;

        const data = await dataPromise;
        const initialData = new Uint8Array(data);
        subArrays.push(initialData);

        const transport = new PDFDataRangeTransport(
          data.length,
          initialData,
          /* progressiveDone = */ true
        );
        transport.requestDataRange = function (begin, end) {
          fetches++;
        };

        const loadingTask = getDocument({
          disableRange: true,
          range: transport,
        });
        const pdfDocument = await loadingTask.promise;
        expect(pdfDocument.numPages).toEqual(14);

        const pdfPage = await pdfDocument.getPage(10);
        expect(pdfPage.rotate).toEqual(0);
        expect(fetches).toEqual(0);

        if (!isNodeJS) {
          // Check that the TypedArrays were transferred.
          for (const array of subArrays) {
            expect(array.length).toEqual(0);
          }
        }

        await loadingTask.destroy();
      }
    );
  });

  describe("PDFWorkerUtil", function () {
    describe("isSameOrigin", function () {
      const { isSameOrigin } = PDFWorkerUtil;

      it("handles invalid base URLs", function () {
        // The base URL is not valid.
        expect(isSameOrigin("/foo", "/bar")).toEqual(false);

        // The base URL has no origin.
        expect(isSameOrigin("blob:foo", "/bar")).toEqual(false);
      });

      it("correctly checks if the origin of both URLs matches", function () {
        expect(
          isSameOrigin(
            "https://www.mozilla.org/foo",
            "https://www.mozilla.org/bar"
          )
        ).toEqual(true);
        expect(
          isSameOrigin(
            "https://www.mozilla.org/foo",
            "https://www.example.com/bar"
          )
        ).toEqual(false);
      });
    });
  });
});
