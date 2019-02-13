#!/usr/bin/env node

'use strict'

var fs = require('fs')
var path = require('path')
var xpath = require('xpath')
var xmldom = require('xmldom')

const program = require('commander')

function parseQuality (val) {
  var number = parseInt(val)
  if (isNaN(number) || number <= 0 || number > 100) {
    throw new Error('Invalid quality value given')
  }
  return number
}

function parseScale (val) {
  var number = parseFloat(val)
  if (isNaN(number) || number <= 0) {
    throw new Error('Invalid scale value given')
  }
  return number
}

function parseBounds (val) {
  var list = val.split('x').map(Number);
  if (list.length != 2) {
    throw new Error('Dimensions must exactly be two items')
  }
  if (list[0] <= 0 || list[1] <= 0) {
    throw new Error('Dimensions must be positive')
  }
  return {width: list[0], height: list[1]}
}

let inputFilename = null
var input = null
var output = null

program
  .name('drawio-batch')
  .version(require('./package.json').version)
  .option('-f --format <format>',
    'ignored, for backwards compatibility. File type is determined from output extension',
    /^(pdf|svg|gif|png|jpeg|bmp|ppm)$/, 'pdf')
  .option('-q --quality <quality>',
    'output image quality for JPEG and PNG (0..100)', parseQuality, 75)
  .option('-s --scale <scale>',
    'scales the output file size for pixel-based output formats', parseScale, 1.0)
  .option('-b --bounds <WxH>',
    'Fits the generated image into the specified bounds, preserves aspect ratio.', parseBounds, {width: 0, height: 0})
  .option('-d --diagramId <diagramId>',
    'selects a specific diagram', parseInt, 0)
  .arguments('<input> <output>')
  .action(function (newInput, newOutput) {
    inputFilename = newInput
    input = fs.readFileSync(newInput, 'utf-8')
    output = newOutput
  })
  .parse(process.argv)

const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox', '--disable-web-security']})

  try {
    await input
    const doc = new xmldom.DOMParser().parseFromString(input);
    const diagrams = xpath.select('//diagram', doc);
    const page = await browser.newPage()

    await page.goto('file://' + __dirname + '/drawio/src/main/webapp/export3.html')
    await page.evaluateHandle('document.fonts.ready');
    
    for (let diagramId = 0; diagramId < diagrams.length; diagramId++) {
  
      await page.evaluate(function (xml, format, bounds, scale, diagramId) {
        return render({
          xml: xml,
          format: format,
          scale: scale,
          w: bounds.width,
          h: bounds.height,
          from: diagramId,
        })
      }, input, program.format, program.bounds, program.scale, diagramId)
  
      await page.waitForSelector('#LoadingComplete');
      var bounds = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('bounds'));
      var bounds = JSON.parse(bounds);
  
      var width = Math.ceil(bounds.x + bounds.width)
      var height = Math.ceil(bounds.y + bounds.height)
  
      await page.setViewport({width: width, height: height})
  
      const filenameBase = fs.statSync(output).isDirectory() ? path.join(output, path.basename(inputFilename)).split('.') : output.split('.');
      filenameBase.pop();
      if (diagrams.length > 1) {
        filenameBase.push(diagramId);
      }
      const extension = fs.statSync(output).isDirectory() ? program.format : output.split('.').pop().toLowerCase();
      const outputFilename = filenameBase.join('.') + '.' + extension;

      if (extension === 'pdf') {
        await page.pdf({path: outputFilename, width: width, height: height + 1, pageRanges: '1'})
      } else if (extension === 'svg') {
        // extracts the inline SVG element used for rendering the diagram and puts it into a file with appropriate SVG headers
  
        // get the rendered page content and parse it as XML again
        var domText = await page.evaluate(() => {
          const svgElement = document.querySelector('svg');
          if (!svgElement.getAttribute('xmlns')) {
            svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          }
          if (!svgElement.getAttribute('xmlns:xlink')) {
            svgElement.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
          }
          if (!svgElement.getAttribute('height')) {
            svgElement.setAttribute('height', svgElement.height.baseVal.value);
          }
          if (!svgElement.getAttribute('width')) {
            svgElement.setAttribute('width', svgElement.width.baseVal.value);
          }
          svgElement.querySelectorAll('div').forEach(div => {
            if (!div.getAttribute('xmlns')) {
              div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
              div.style.whiteSpace = "nowrap";
              div.style.overflow = "visible";
            }
          });
          return svgElement.parentElement.innerHTML;
        });
        
        var svgNode = new xmldom.DOMParser().parseFromString(domText, 'text/html')
        var serializer = new xmldom.XMLSerializer()
        var source = serializer.serializeToString(svgNode)
        source = '<?xml version="1.0" standalone="no"?>\r\n' + source;
        fs.writeFile(outputFilename, source, function(err) {
          if (err) {
            return console.log(err)
          }
        });
  
      } else {
        await page.screenshot({path: outputFilename, clip: bounds, quality: process.quality})
      }
      await page.mainFrame().$eval('#LoadingComplete', div => div.parentNode.removeChild(div))
      await page.mainFrame().$eval('svg', svg => svg.parentNode.removeChild(svg))
    }
  } catch (error) {
    console.log(error)
    process.exit(1)
  } finally {
    await browser.close()
  }
})()
