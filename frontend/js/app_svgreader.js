/**
  SVG parser for the Lasersaur.
  Converts SVG DOM to a flat collection of paths.
  
  Copyright (c) 2011 Nortd Labs
  Open Source by the terms of the Gnu Public License (GPL3) or higher.
  
  Code inspired by cake.js, canvg.js, svg2obj.py, and Squirtle.
  Thank you for open sourcing your work!

  Usage:
  var boundarys = SVGReader.parse(svgstring, config)

  Features:
    * <svg> width and height, viewBox clipping.
    * paths, rectangles, ellipses, circles, lines, polylines and polygons
    * nested transforms
    * transform lists (transform="rotate(30) translate(2,2) scale(4)")
    * non-pixel units (cm, mm, in, pt, pc)
    * 'style' attribute and presentation attributes
    * curves, arcs, cirles, ellipses tesellated according to tolerance
    
  Intentinally not Supported:
    * markers
    * masking
    * em, ex, % units
    * text (needs to be converted to paths)
    * raster images
    * style sheets

  ToDo:
    * check for out of bounds geometry
*/


SVGReader = {
  
  boundarys : {},
  rasters : [],
    // output path flattened (world coords)
    // hash of path by color
    // each path is a list of subpaths
    // each subpath is a list of verteces
  dpi: undefined,
    // the dpi with which the svg's "user unit/px" unit was exported
  target_size: [1220,610],
    // what the svg size (typically page dimensions) should be mapped to
  style : {},  
    // style at current parsing position
  tolerance : 0.1,
  tolerance2 : undefined,
  tolerance2_px: undefined,
  tolerance2_half: undefined,
  epsilon : undefined,
  epsilon2 : undefined,
    // tolerance optimizing (tesselating, simplifying) curvy shapes (mm)
  join_count : 0,
    // number of subpath joined
  ignore_tags : {'defs':undefined, 'pattern':undefined, 'clipPath':undefined},
    // tags to ignore for this parser
  optimize : true,
    // do all kinds of path optimizations


    
  parse : function(svgstring, config) {
    this.join_count = 0;
    this.boundarys = {};
    this.rasters = [];
    if ('optimize' in config) {
      this.optimize = config['optimize'];
    }
    
    if ('dpi' in config && config['dpi']) {
      this.dpi = config['dpi'];
      $().uxmessage('notice', "SVG import forced to "+this.dpi+"dpi.");
    } else {
      // look for clues  of svg generator app and it's DPI
      var svghead = svgstring.slice(0,400);
      if (svghead.search(/Inkscape/i) != -1) {
        this.dpi = 90;
        $().uxmessage('notice', "SVG exported with Inkscape -> 90dpi.");      
      } else if (svghead.search(/Illustrator/i) != -1) {
        this.dpi = 72;
        $().uxmessage('notice', "SVG exported with Illustrator -> 72dpi.");
      } else if (svghead.search(/Intaglio/i) != -1) {
        this.dpi = 72;
        $().uxmessage('notice', "SVG exported with Intaglio -> 72dpi.");
      } else if (svghead.search(/CorelDraw/i) != -1) {
        this.dpi = 96;
        $().uxmessage('notice', "SVG exported with CorelDraw -> 96dpi.");
      } else if (svghead.search(/Qt/i) != -1) {
        this.dpi = 90;
        $().uxmessage('notice', "SVG exported with Qt lib -> 90dpi.");
      }
    }
    if ('target_size' in config) {
      this.target_size = config['target_size'];
    }
    // parse xml
    var svgRootElement;
        if (window.DOMParser) {
            var parser = new DOMParser();
            svgRootElement = parser.parseFromString(svgstring, 'text/xml').documentElement;
        }
        else {
            xml = xml.replace(/<!DOCTYPE svg[^>]*>/, '');
            var xmlDoc = new ActiveXObject('Microsoft.XMLDOM');
            xmlDoc.async = 'false';
            xmlDoc.loadXML(svgstring); 
            svgRootElement = xmlDoc.documentElement;
        }
        
    // figure out how to map px to mm, using document page size
    if (!this.dpi) {
      this.parseRoot(svgRootElement);
      if (this.dpi) {
        $().uxmessage('notice', "Unit conversion from page size: " + this.dpi.toFixed(0) + 'dpi');
      } else {
        $().uxmessage('warning', "Cannot parse page size -> defaulting to 90dpi.");
        this.dpi = 90;        
      }
    }
    
    // adjust tolerances to px units
    var mm2px = this.dpi/25.4;
    this.tolerance2 = this.tolerance*this.tolerance;
    this.tolerance2_px = (mm2px*this.tolerance)*(mm2px*this.tolerance);
    this.tolerance2_half = (0.5*this.tolerance)*(0.5*this.tolerance);
    this.epsilon = 0.1*this.tolerance;
    this.epsilon2 = this.epsilon*this.epsilon;
    
    
    // let the fun begin
    // recursively parse children
    // output will be in this.boundarys    
    var node = {}
    node.stroke = [0,0,0];
    node.xformToWorld = [1,0,0,1,0,0];    
    this.parseChildren(svgRootElement, node);
    
    // optimize and sort polylines
    if (this.optimize) {
      var totalverts = 0;
      var optiverts = 0;
      for (var col in this.boundarys) {
        var subpaths = this.boundarys[col];  // by color
        // optimize polylines with high-vertex counts
        // as many apps export highly tesselated polylines
        for (var u=0; u<subpaths.length; u++) {
          totalverts += subpaths[u].length;
          subpaths[u] = this.poly_simplify(subpaths[u], this.tolerance2_half);
          optiverts += subpaths[u].length;
        }
        // sort subpath to optimize seek distances in between
        var endpoint = [0,0];  // start at the origin
        for (var i=0; i<subpaths.length; i++) {
          if (i > 0) {
            endpoint = subpaths[i-1][subpaths[i-1].length-1];
          }
          // search the rest of array for closest subpath start point
          var d2_hash = {}  // distance2:index pairs
          for (var j=i; j<subpaths.length; j++) {
            var startpoint = subpaths[j][0];
            d2_hash[Math.pow(endpoint[0]-startpoint[0],2) + Math.pow(endpoint[1]-startpoint[1],2)] = j;
          }
          var d2min = Infinity;
          var d2minIndex = undefined;
          for (var d2 in d2_hash) {
            if (parseFloat(d2) < d2min) {
              d2min = d2; 
              d2minIndex = d2_hash[d2];
            }
          }
          // make closest subpath next item
          if (d2minIndex != i) {
            var tempItem = subpaths[i];
            subpaths[i] = subpaths[d2minIndex];
            subpaths[d2minIndex] = tempItem;  
          }
        }
      }    
      // report pseudo-polyline joining operations
      if (this.join_count > 100) {
        $().uxmessage('notice', 'SVGReader: joined many line segments: ' + this.join_count);
      } 
      // report polyline optimizations    
      var difflength = totalverts - optiverts;
      var diffpct = (100*difflength/totalverts);
      if (diffpct > 10) {  // if diff more than 10%
        $().uxmessage('notice', 'SVGReader: polylines optimized by ' + diffpct.toFixed(0) + '%');
      }
    }
    
    return { boundarys : this.boundarys, rasters : this.rasters};
    
  },
  
  
  parseRoot : function(rootNode) {
    // we are specifically interested in the width/height/viewBox attribute
    // this is used to determin the page size and consequently the implied dpi of px units
    if (rootNode.tagName == 'svg') {
      var node = {};
      this.SVGTagMapping[rootNode.tagName](this, rootNode, node);
    }    
  },
  
  parseChildren : function(domNode, parentNode) {
    var childNodes = []
    for (var i=0; i<domNode.childNodes.length; i++) {
      var tag = domNode.childNodes[i]
      if (tag.childNodes) {
        if (tag.tagName) {
          if (tag.tagName in this.ignore_tags) {
            // ignore certain tags that are not relevant for this parser
            continue; 
          }          
          // we are looping here through 
          // all nodes with child nodes
          // others are irrelevant

          // 1.) setup a new node
          // and inherit from parent
          var node = {}
          node.path = [];
// I:FABOOL Start
          node.image = [];
// I:FABOOL End
          node.xform = [1,0,0,1,0,0];
          node.opacity = parentNode.opacity;
          node.display = parentNode.display;
          node.visibility = parentNode.visibility;
          node.fill = parentNode.fill;
          node.stroke = parentNode.stroke;
          node.color = parentNode.color;
          node.fillOpacity = parentNode.fillOpacity;
          node.strokeOpacity = parentNode.strokeOpacity;
          
          // 2.) parse own attributes and overwrite
          if (tag.attributes) {
            for (var j=0; j<tag.attributes.length; j++) {
              var attr = tag.attributes[j]
              if (attr.nodeName && attr.nodeValue && this.SVGAttributeMapping[attr.nodeName]) {
                this.SVGAttributeMapping[attr.nodeName](this, node, attr.nodeValue)
              }
            }
          }
          
          // 3.) accumulate transformations
          node.xformToWorld = this.matrixMult(parentNode.xformToWorld, node.xform)
          
          // 4.) parse tag 
          // with current attributes and transformation
          if (this.SVGTagMapping[tag.tagName]) {
            this.SVGTagMapping[tag.tagName](this, tag, node)
          }
          
          // 5.) compile boundarys + conversions
          for (var k=0; k<node.path.length; k++) {
            var subpath = node.path[k];
            if (subpath.length == 0) {continue;}  // skip if empty subpath
            // 5a.) convert to world coordinates and then to mm units
            for (var l=0; l<subpath.length; l++) {
              subpath[l] = this.matrixApply(node.xformToWorld, subpath[l]);
              subpath[l] = this.vertexScale(subpath[l], 25.4/this.dpi);
            }
            // 5b.) sort output by color
            var hexcolor = this.rgbToHex(node.stroke[0], node.stroke[1], node.stroke[2]);
            if (hexcolor in this.boundarys) {
              // 5c.) join subpaths with congruent end/start points
              // may apps export many short line segments instead of nice polylines              
              var colsubpaths = this.boundarys[hexcolor];
              var lastsubpath = colsubpaths[colsubpaths.length-1];
              var endpoint = lastsubpath[lastsubpath.length-1];
              var d2 = Math.pow(endpoint[0]-subpath[0][0],2) + Math.pow(endpoint[1]-subpath[0][1],2);
              if ((d2 < this.epsilon2) && this.optimize) {
                // previous subpath (of same color) end where this one starts
                // concat subpath to previous subpath, drop first point
                this.join_count++;
                lastsubpath.push.apply(lastsubpath, subpath.slice(1));  //in-place concat
              } else {
                this.boundarys[hexcolor].push(subpath);
              }
            } else {
              this.boundarys[hexcolor] = [subpath];
            }
          }
// I:FABOOL Start
          for (var k=0; k<node.image.length; k++) {
            var subimage = node.image[k];

            subimage[0] = this.matrixApply(node.xformToWorld, subimage[0]);
            subimage[0] = this.vertexScale(subimage[0], 25.4/this.dpi);

            subimage[1] = this.matrixApplyWithOutPos(node.xformToWorld, subimage[1]);
            subimage[1] = this.vertexScale(subimage[1], 25.4/this.dpi);

            this.rasters.push(subimage);
          }
// I:FABOOL End
        }
        
        // recursive call
        this.parseChildren(tag, node)
      }
    }  
  },
  
  
  rgbToHex : function(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  },



  /////////////////////////////
  // recognized svg attributes
  
  SVGAttributeMapping : {
    DEG_TO_RAD : Math.PI / 180,
    RAD_TO_DEG : 180 / Math.PI,

    id : function(parser, node, val) {
      node.id = val
    },   

    transform : function(parser, node, val) {
      // http://www.w3.org/TR/SVG11/coords.html#EstablishingANewUserSpace
      var xforms = []
      var segs = val.match(/[a-z]+\s*\([^)]*\)/ig)
      for (var i=0; i<segs.length; i++) {
        var kv = segs[i].split("(");
        var xformKind = kv[0].strip();
        var paramsTemp = kv[1].strip().slice(0,-1);
        var params = paramsTemp.split(/[\s,]+/).map(parseFloat)
        // double check params
        for (var j=0; j<params.length; j++) {
          if ( isNaN(params[j]) ) {
            $().uxmessage('warning', 'transform skipped; contains non-numbers');
            continue  // skip this transform
          }
        }
        
        // translate
        if (xformKind == 'translate') {
          if (params.length == 1) {
            xforms.push([1, 0, 0, 1, params[0], params[0]])
          } else if (params.length == 2) {
            xforms.push([1, 0, 0, 1, params[0], params[1]])
          } else {
            $().uxmessage('warning', 'translate skipped; invalid num of params');
          }
        // rotate         
        } else if (xformKind == 'rotate') {
          if (params.length == 3) {
            var angle = params[0] * this.DEG_TO_RAD
            xforms.push([1, 0, 0, 1, params[1], params[2]])
            xforms.push([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0])
            xforms.push([1, 0, 0, 1, -params[1], -params[2]])
          } else if (params.length == 1) {
            var angle = params[0] * this.DEG_TO_RAD
            xforms.push([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0])
          } else {
            $().uxmessage('warning', 'rotate skipped; invalid num of params');
          }
        //scale       
        } else if (xformKind == 'scale') {
          if (params.length == 1) {
            xforms.push([params[0], 0, 0, params[0], 0, 0])
          } else if (params.length == 2) {
            xforms.push([params[0], 0, 0, params[1], 0, 0])
          } else {
            $().uxmessage('warning', 'scale skipped; invalid num of params');
          }
        // matrix
        } else if (xformKind == 'matrix') {
          if (params.length == 6) {
            xforms.push(params)
          }
        // skewX        
        } else if (xformKind == 'skewX') {
          if (params.length == 1) {
            var angle = params[0]*this.DEG_TO_RAD
            xforms.push([1, 0, Math.tan(angle), 1, 0, 0])
          } else {
            $().uxmessage('warning', 'skewX skipped; invalid num of params');
          }
        // skewY
        } else if (xformKind == 'skewY') {
          if (params.length == 1) {
            var angle = params[0]*this.DEG_TO_RAD
            xforms.push([1, Math.tan(angle), 0, 1, 0, 0])
          } else {
            $().uxmessage('warning', 'skewY skipped; invalid num of params');
          }
        }
      }

      //calculate combined transformation matrix
      xform_combined = [1,0,0,1,0,0]
      for (var i=0; i<xforms.length; i++) {
        xform_combined = parser.matrixMult(xform_combined, xforms[i])
      }
      
      // assign
      node.xform = xform_combined  
    },

    style : function(parser, node, val) {
      // style attribute
      // http://www.w3.org/TR/SVG11/styling.html#StyleAttribute
      // example: <rect x="200" y="100" width="600" height="300" 
      //          style="fill: red; stroke: blue; stroke-width: 3"/>
      
      // relay to parse style attributes the same as Presentation Attributes
      var segs = val.split(";")
      for (var i=0; i<segs.length; i++) {
        var kv = segs[i].split(":")
        var k = kv[0].strip()
        if (this[k]) {
          var v = kv[1].strip()
          this[k](parser, node, v)
        }
      }
    }, 
    
    ///////////////////////////
    // Presentations Attributes 
    // http://www.w3.org/TR/SVG11/styling.html#UsingPresentationAttributes
    // example: <rect x="200" y="100" width="600" height="300" 
    //          fill="red" stroke="blue" stroke-width="3"/>
    
    opacity : function(parser, node, val) {
      node.opacity = parseFloat(val)
    },

    display : function (parser, node, val) {
      node.display = val
    },

    visibility : function (parser, node, val) {
      node.visibility = val
    },

    fill : function(parser, node, val) {
      node.fill = this.__parseColor(val, node.color)
    },

    stroke : function(parser, node, val) {
      node.stroke = this.__parseColor(val, node.color)
    },

    color : function(parser, node, val) {
      if (val == 'inherit') return
      node.color = this.__parseColor(val, node.color)
    },

    'fill-opacity' : function(parser, node, val) {
      node.fillOpacity = Math.min(1,Math.max(0,parseFloat(val)))
    },

    'stroke-opacity' : function(parser, node, val) {
      node.strokeOpacity = Math.min(1,Math.max(0,parseFloat(val)))
    },

    // Presentations Attributes 
    ///////////////////////////

    __parseColor : function(val, currentColor) {

      if (val.charAt(0) == '#') {
        if (val.length == 4)
          val = val.replace(/([^#])/g, '$1$1')
        var a = val.slice(1).match(/../g).map(
          function(i) { return parseInt(i, 16) })
        return a

      } else if (val.search(/^rgb\(/) != -1) {
        var a = val.slice(4,-1).split(",")
        for (var i=0; i<a.length; i++) {
          var c = a[i].strip()
          if (c.charAt(c.length-1) == '%')
            a[i] = Math.round(parseFloat(c.slice(0,-1)) * 2.55)
          else
            a[i] = parseInt(c)
        }
        return a

      } else if (val.search(/^rgba\(/) != -1) {
        var a = val.slice(5,-1).split(",")
        for (var i=0; i<3; i++) {
          var c = a[i].strip()
          if (c.charAt(c.length-1) == '%')
            a[i] = Math.round(parseFloat(c.slice(0,-1)) * 2.55)
          else
            a[i] = parseInt(c)
        }
        var c = a[3].strip()
        if (c.charAt(c.length-1) == '%')
          a[3] = Math.round(parseFloat(c.slice(0,-1)) * 0.01)
        else
          a[3] = Math.max(0, Math.min(1, parseFloat(c)))
        return a

      } else if (val.search(/^url\(/) != -1) {
        $().uxmessage('error', "defs are not supported at the moment");
      } else if (val == 'currentColor') {
        return currentColor
      } else if (val == 'none') {
        return 'none'
      } else if (val == 'freeze') { // SMIL is evil, but so are we
        return null
      } else if (val == 'remove') {
        return null
      } else { // unknown value, maybe it's an ICC color
        return val
      }
    }
  },
  
  // recognized svg attributes
  /////////////////////////////


  


  ///////////////////////////
  // recognized svg elements
  
  SVGTagMapping : {
    svg : function(parser, tag, node) {
      // has style attributes
      node.fill = 'black'
      node.stroke = 'none'
      // figure out SVG's immplied dpi
      // SVGs have user units/pixel that have an implied dpi.
      // Inkscape typically uses 90dpi, Illustrator and Intaglio use 72dpi.
      // We can use the width/height and/or viewBox attributes on the svg tag
      // and map the document neatly onto the desired dimensions.
      var w = tag.getAttribute('width');
      var h = tag.getAttribute('height');
      if (!w || !h) {
        // get size from viewBox
        var vb = tag.getAttribute('viewBox');
        if (vb) {
          var vb_parts = vb.split(',');
          if (vb_parts.length != 4) {
            vb_parts = vb.split(' ');
          }
          if (vb_parts.length == 4) {
            w = vb_parts[2];
            h = vb_parts[3];
          }
        }
      }
      if (w && h) {
        if (w.search(/cm$/i) != -1) {
          $().uxmessage('error', "Not supported: Page size in 'cm'.");
        } else if (w.search(/mm$/i) != -1) {
          $().uxmessage('error', "Not supported: Page size in 'mm'.");
        } else if (w.search(/pt$/i) != -1) {
          $().uxmessage('error', "Not supported: Page size in 'pt'.");
        } else if (w.search(/pc$/i) != -1) {
          $().uxmessage('error', "Not supported: Page size in 'pc'.");
        } else if (w.search(/in$/i) != -1) {
          $().uxmessage('error', "Not supported: Page size in 'in'.");
        }
        w = parseFloat(w.strip());
        h = parseFloat(h.strip());       
        parser.dpi = Math.round(25.4*w/parser.target_size[0]);
      }
    },
    
    
    g : function(parser, tag, node) {
      // http://www.w3.org/TR/SVG11/struct.html#Groups
      // has transform and style attributes
    },


    polygon : function(parser, tag, node) {
      // http://www.w3.org/TR/SVG11/shapes.html#PolygonElement
      // has transform and style attributes
      var d = this.__getPolyPath(tag)
      d.push('z')
      parser.addPath(d, node)      
    },


    polyline : function(parser, tag, node) {
      // http://www.w3.org/TR/SVG11/shapes.html#PolylineElement
      // has transform and style attributes
      var d = this.__getPolyPath(tag)
      parser.addPath(d, node)
    },
    
    __getPolyPath : function(tag) {
      // has transform and style attributes
      var subpath = []
      var vertnums = tag.getAttribute("points").toString().strip().split(/[\s,]+/).map(parseFloat)
      if (vertnums.length % 2 == 0) {
        var d = ['M']
        d.push(vertnums[0])
        d.push(vertnums[1])
        for (var i=2; i<vertnums.length; i+=2) {
          d.push(vertnums[i])
          d.push(vertnums[i+1])
        }
        return d
      } else {
        $().uxmessage('error', "in __getPolyPath: odd number of verteces");
      }
    },

    rect : function(parser, tag, node) {
      // http://www.w3.org/TR/SVG11/shapes.html#RectElement
      // has transform and style attributes      
      var w = parser.parseUnit(tag.getAttribute('width')) || 0
      var h = parser.parseUnit(tag.getAttribute('height')) || 0
      var x = parser.parseUnit(tag.getAttribute('x')) || 0
      var y = parser.parseUnit(tag.getAttribute('y')) || 0
      var rx = parser.parseUnit(tag.getAttribute('rx'))
      var ry = parser.parseUnit(tag.getAttribute('ry'))
      
      if(rx == null || ry == null) {  // no rounded corners
        var d = ['M', x, y, 'h', w, 'v', h, 'h', -w, 'z'];
        parser.addPath(d, node)
      } else {                       // rounded corners
            if ('ry' == null) { ry = rx; }
            if (rx < 0.0) { rx *=-1; }
            if (ry < 0.0) { ry *=-1; }
            d = ['M', x+rx , y ,
                     'h', w-2*rx,
                     'c', rx, 0.0, rx, ry, rx, ry,
                     'v', h-ry,
                     'c', '0.0', ry, -rx, ry, -rx, ry,
                     'h', -w+2*rx,
                     'c', -rx, '0.0', -rx, -ry, -rx, -ry,
                     'v', -h+ry,
                     'c', '0.0','0.0','0.0', -ry, rx, -ry,
                     'z'];
        parser.addPath(d, node)        
      }
    },


    line : function(parser, tag, node) {
      // http://www.w3.org/TR/SVG11/shapes.html#LineElement
      // has transform and style attributes
      var x1 = parser.parseUnit(tag.getAttribute('x1')) || 0
      var y1 = parser.parseUnit(tag.getAttribute('y1')) || 0
      var x2 = parser.parseUnit(tag.getAttribute('x2')) || 0
      var y2 = parser.parseUnit(tag.getAttribute('y2')) || 0      
      var d = ['M', x1, y1, 'L', x2, y2]
      parser.addPath(d, node)        
    },


    circle : function(parser, tag, node) {
      // http://www.w3.org/TR/SVG11/shapes.html#CircleElement
      // has transform and style attributes      
      var r = parser.parseUnit(tag.getAttribute('r'))
      var cx = parser.parseUnit(tag.getAttribute('cx')) || 0
      var cy = parser.parseUnit(tag.getAttribute('cy')) || 0
      
      if (r > 0.0) {
        var d = ['M', cx-r, cy,                  
                     'A', r, r, 0, 0, 0, cx, cy+r,
                     'A', r, r, 0, 0, 0, cx+r, cy,
                     'A', r, r, 0, 0, 0, cx, cy-r,
                     'A', r, r, 0, 0, 0, cx-r, cy,
                     'Z'];
        parser.addPath(d, node);
      }
    },


    ellipse : function(parser, tag, node) {
      // has transform and style attributes
      var rx = parser.parseUnit(tag.getAttribute('rx'))
      var ry = parser.parseUnit(tag.getAttribute('ry'))
      var cx = parser.parseUnit(tag.getAttribute('cx')) || 0
      var cy = parser.parseUnit(tag.getAttribute('cy')) || 0
      
      if (rx > 0.0 && ry > 0.0) {    
        var d = ['M', cx-rx, cy,                  
                     'A', rx, ry, 0, 0, 0, cx, cy+ry,
                     'A', rx, ry, 0, 0, 0, cx+rx, cy,
                     'A', rx, ry, 0, 0, 0, cx, cy-ry,
                     'A', rx, ry, 0, 0, 0, cx-rx, cy,
                     'Z'];          
        parser.addPath(d, node);
      }
    },

    
    path : function(parser, tag, node) {
      // http://www.w3.org/TR/SVG11/paths.html
      // has transform and style attributes
      var d = tag.getAttribute("d")
      parser.addPath(d, node) 
    },    
    
    image : function(parser, tag, node) {
      // has transform and style attributes
      var x = parser.parseUnit(tag.getAttribute('x')) || 0;
      var y = parser.parseUnit(tag.getAttribute('y')) || 0;
      var width = parser.parseUnit(tag.getAttribute('width')) || 0;
      var height = parser.parseUnit(tag.getAttribute('height')) || 0;
      var data_url = tag.getAttribute('xlink:href');

      var imageData = [];
      imageData.push([x, y]);
      imageData.push([width, height]);
      imageData.push(data_url);

      node.image.push(imageData);
    },
    
    defs : function(parser, tag, node) {
      // not supported
      // http://www.w3.org/TR/SVG11/struct.html#Head
      // has transform and style attributes      
    },
    
    style : function(parser, tag, node) {
      // not supported: embedded style sheets
      // http://www.w3.org/TR/SVG11/styling.html#StyleElement
      // instead presentation attributes and the 'style' attribute      
      // var style = tag.getAttribute("style")
      // if (style) {
      //   var segs = style.split(";")
      //   for (var i=0; i<segs.length; i++) {
      //     var kv = segs[i].split(":")
      //     var k = kv[0].strip()
      //     if (this.SVGAttributeMapping[k]) {
      //       var v = kv[1].strip()
      //       this.SVGAttributeMapping[k].call(v, defs, st)
      //     }
      //   }
      // }      
    }    
        
  },

  // recognized svg elements
  ///////////////////////////



  //////////////////////////////////////////////////////////////////////////
  // handle path data
  // this is where all the geometry gets converted for the boundarys output

  addPath : function(d, node) {
    // http://www.w3.org/TR/SVG11/paths.html#PathData
    
    var tolerance2 = this.tolerance2_px;
    var totalMaxScale = this.matrixGetScale(node.xformToWorld);
    if (totalMaxScale != 0) {
      // adjust for possible transforms
      tolerance2 /= Math.pow(totalMaxScale, 2);
      // $().uxmessage('notice', "tolerance2: " + tolerance2.toString());
    }
    
    if ( typeof d == 'string') {
      // parse path string
      d = d.match(/([A-Za-z]|-?[0-9]+\.?[0-9]*(?:e-?[0-9]*)?)/g);
      for (var i=0; i<d.length; i++) {
        var num = parseFloat(d[i]);
        if (!isNaN(num)) {
          d[i] = num;
        }
      }
    }
    //$().uxmessage('notice', "d: " + d.toString());
    
    function nextIsNum () {
      return (d.length > 0) && (typeof(d[0]) === 'number');
    }
    
    function getNext() {
      if (d.length > 0) {
        return d.shift();  // pop first item
      } else {
        $().uxmessage('error', "in addPath: not enough parameters");
        return null;
      }
    }
    
    var x = 0;
    var y = 0;
    var cmdPrev = '';
    var xPrevCp;
    var yPrevCp;
    var subpath = [];    
    
    while (d.length > 0) {
      var cmd = getNext();
      switch(cmd) {
        case 'M':  // moveto absolute
          // start new subpath
          if ( subpath.length > 0) {
            node.path.push(subpath);
            subpath = [];
          }
          var implicitVerts = 0
          while (nextIsNum()) {
            x = getNext();
            y = getNext();
            subpath.push([x, y]);
            implicitVerts += 1;
          }
          break
        case 'm':  //moveto relative
          // start new subpath
          if ( subpath.length > 0) {
            node.path.push(subpath);
            subpath = [];
          } 
          if (cmdPrev == '') {
            // first treated absolute
            x = getNext();
            y = getNext();
            subpath.push([x, y]);
          }
          var implicitVerts = 0       
          while (nextIsNum()) {
            // subsequent treated realtive
            x += getNext();
            y += getNext();
            subpath.push([x, y]);
            implicitVerts += 1;            
          }
          break;
        case 'Z':  // closepath
          // loop and finalize subpath
          if ( subpath.length > 0) {
            subpath.push(subpath[0]);  // close
            node.path.push(subpath);
            subpath = [];
          }      
          break;
        case 'z':  // closepath
          // loop and finalize subpath
          if ( subpath.length > 0) {
            subpath.push(subpath[0]);  // close
            node.path.push(subpath);
            subpath = [];
          }  
          break          
        case 'L':  // lineto absolute
          while (nextIsNum()) {
            x = getNext();
            y = getNext();
            subpath.push([x, y]);
          }
          break
        case 'l':  // lineto relative
          while (nextIsNum()) {
            x += getNext();
            y += getNext();
            subpath.push([x, y]);
          }
          break
        case 'H':  // lineto horizontal absolute
          while (nextIsNum()) {
            x = getNext();
            subpath.push([x, y]);
          }
          break
        case 'h':  // lineto horizontal relative
          while (nextIsNum()) {
            x += getNext();
            subpath.push([x, y]);
          }
          break;
        case 'V':  // lineto vertical absolute
          while (nextIsNum()) {
            y = getNext()
            subpath.push([x, y])
          }
          break;
        case 'v':  // lineto vertical realtive
          while (nextIsNum()) {
            y += getNext();
            subpath.push([x, y]);
          }
          break;
        case 'C':  // curveto cubic absolute
          while (nextIsNum()) {
            var x2 = getNext();
            var y2 = getNext();
            var x3 = getNext();
            var y3 = getNext();
            var x4 = getNext();
            var y4 = getNext();
            subpath.push([x,y]);
            this.addCubicBezier(subpath, x, y, x2, y2, x3, y3, x4, y4, 0, tolerance2);
            subpath.push([x4,y4]);
            x = x4;
            y = y4;
            xPrevCp = x3;
            yPrevCp = y3;
          }
          break
        case 'c':  // curveto cubic relative
          while (nextIsNum()) {
            var x2 = x + getNext();
            var y2 = y + getNext();
            var x3 = x + getNext();
            var y3 = y + getNext();
            var x4 = x + getNext();
            var y4 = y + getNext();
            subpath.push([x,y]);
            this.addCubicBezier(subpath, x, y, x2, y2, x3, y3, x4, y4, 0, tolerance2);
            subpath.push([x4,y4]);
            x = x4;
            y = y4;
            xPrevCp = x3;
            yPrevCp = y3;
          }        
          break
        case 'S':  // curveto cubic absolute shorthand
          while (nextIsNum()) {
            var x2;
            var y2;
            if (cmdPrev.match(/[CcSs]/)) {
              x2 = x-(xPrevCp-x);
              y2 = y-(yPrevCp-y); 
            } else {
              x2 = x;
              y2 = y;              
            }
            var x3 = getNext();
            var y3 = getNext();
            var x4 = getNext();
            var y4 = getNext();
            subpath.push([x,y]);
            this.addCubicBezier(subpath, x, y, x2, y2, x3, y3, x4, y4, 0, tolerance2);
            subpath.push([x4,y4]);
            x = x4;
            y = y4;
            xPrevCp = x3;
            yPrevCp = y3;
          }                                 
          break
        case 's':  // curveto cubic relative shorthand
          while (nextIsNum()) {
            var x2;
            var y2;
            if (cmdPrev.match(/[CcSs]/)) {
              x2 = x-(xPrevCp-x);
              y2 = y-(yPrevCp-y); 
            } else {
              x2 = x;
              y2 = y;              
            }
            var x3 = x + getNext();
            var y3 = y + getNext();
            var x4 = x + getNext();
            var y4 = y + getNext();
            subpath.push([x,y]);
            this.addCubicBezier(subpath, x, y, x2, y2, x3, y3, x4, y4, 0, tolerance2);
            subpath.push([x4,y4]);
            x = x4;
            y = y4;
            xPrevCp = x3;
            yPrevCp = y3;
          }         
          break
        case 'Q':  // curveto quadratic absolute
          while (nextIsNum()) {
            var x2 = getNext();
            var y2 = getNext();
            var x3 = getNext();
            var y3 = getNext();
            subpath.push([x,y]);
            this.addQuadraticBezier(subpath, x, y, x2, y2, x3, y3, 0, tolerance2);
            subpath.push([x3,y3]);
            x = x3;
            y = y3;        
          }
          break
        case 'q':  // curveto quadratic relative
          while (nextIsNum()) {
            var x2 = x + getNext();
            var y2 = y + getNext();
            var x3 = x + getNext();
            var y3 = y + getNext();
            subpath.push([x,y]);
            this.addQuadraticBezier(subpath, x, y, x2, y2, x3, y3, 0, tolerance2);
            subpath.push([x3,y3]);
            x = x3;
            y = y3;        
          }
          break
        case 'T':  // curveto quadratic absolute shorthand
          while (nextIsNum()) {
            var x2;
            var y2;
            if (cmdPrev.match(/[QqTt]/)) {
              x2 = x-(xPrevCp-x);
              y2 = y-(yPrevCp-y); 
            } else {
              x2 = x;
              y2 = y;              
            }
            var x3 = getNext();
            var y3 = getNext();
            subpath.push([x,y]);
            this.addQuadraticBezier(subpath, x, y, x2, y2, x3, y3, 0, tolerance2);
            subpath.push([x3,y3]);
            x = x3;
            y = y3; 
            xPrevCp = x2;
            yPrevCp = y2;
          }        
          break
        case 't':  // curveto quadratic relative shorthand
          while (nextIsNum()) {
            var x2;
            var y2;
            if (cmdPrev.match(/[QqTt]/)) {
              x2 = x-(xPrevCp-x);
              y2 = y-(yPrevCp-y); 
            } else {
              x2 = x;
              y2 = y;              
            }
            var x3 = x + getNext();
            var y3 = y + getNext();
            subpath.push([x,y]);
            this.addQuadraticBezier(subpath, x, y, x2, y2, x3, y3, 0, tolerance2);
            subpath.push([x3,y3]);
            x = x3;
            y = y3; 
            xPrevCp = x2;
            yPrevCp = y2;
          }
          break
        case 'A':  // eliptical arc absolute
          while (nextIsNum()) {
            var rx = getNext();
            var ry = getNext();
            var xrot = getNext();
            var large = getNext();        
            var sweep = getNext();
            var x2 = getNext();
            var y2 = getNext();        
            this.addArc(subpath, x, y, rx, ry, xrot, large, sweep, x2, y2, tolerance2); 
            x = x2
            y = y2
          }
          break
        case 'a':  // elliptical arc relative
          while (nextIsNum()) {
            var rx = getNext();
            var ry = getNext();
            var xrot = getNext();
            var large = getNext();        
            var sweep = getNext();
            var x2 = x + getNext();
            var y2 = y + getNext();        
            this.addArc(subpath, x, y, rx, ry, xrot, large, sweep, x2, y2, tolerance2); 
            x = x2
            y = y2
          }
          break
      }
      cmdPrev = cmd;
    }
    // finalize subpath
    if ( subpath.length > 0) {
      node.path.push(subpath);
      subpath = [];
    }     
  },
    
  
  addCubicBezier : function(subpath, x1, y1, x2, y2, x3, y3, x4, y4, level, tolerance2) {
    // for details see:
    // http://www.antigrain.com/research/adaptive_bezier/index.html
    // based on DeCasteljau Algorithm
    // The reason we use a subdivision algo over an incremental one
    // is we want to have control over the deviation to the curve.
    // This mean we subdivide more and have more curve points in
    // curvy areas and less in flatter areas of the curve.
    
    if (level > 18) {
      // protect from deep recursion cases
      // max 2**18 = 262144 segments
      return
    }
    
    // Calculate all the mid-points of the line segments
    var x12   = (x1 + x2) / 2.0
    var y12   = (y1 + y2) / 2.0
    var x23   = (x2 + x3) / 2.0
    var y23   = (y2 + y3) / 2.0
    var x34   = (x3 + x4) / 2.0
    var y34   = (y3 + y4) / 2.0
    var x123  = (x12 + x23) / 2.0
    var y123  = (y12 + y23) / 2.0
    var x234  = (x23 + x34) / 2.0
    var y234  = (y23 + y34) / 2.0
    var x1234 = (x123 + x234) / 2.0
    var y1234 = (y123 + y234) / 2.0

    // Try to approximate the full cubic curve by a single straight line
    var dx = x4-x1
    var dy = y4-y1

    var d2 = Math.abs(((x2 - x4) * dy - (y2 - y4) * dx))
    var d3 = Math.abs(((x3 - x4) * dy - (y3 - y4) * dx))

    if ( Math.pow(d2+d3, 2) < 5.0 * tolerance2 * (dx*dx + dy*dy) ) {
      // added factor of 5.0 to match circle resolution
      subpath.push([x1234, y1234])
      return
    }

    // Continue subdivision
    this.addCubicBezier(subpath, x1, y1, x12, y12, x123, y123, x1234, y1234, level+1, tolerance2);
    this.addCubicBezier(subpath, x1234, y1234, x234, y234, x34, y34, x4, y4, level+1, tolerance2);
  },


  addQuadraticBezier : function(subpath, x1, y1, x2, y2, x3, y3, level, tolerance2) {
    if (level > 18) {
      // protect from deep recursion cases
      // max 2**18 = 262144 segments
      return
    }
    
    // Calculate all the mid-points of the line segments
    var x12   = (x1 + x2) / 2.0                
    var y12   = (y1 + y2) / 2.0
    var x23   = (x2 + x3) / 2.0
    var y23   = (y2 + y3) / 2.0
    var x123  = (x12 + x23) / 2.0
    var y123  = (y12 + y23) / 2.0

    var dx = x3-x1
    var dy = y3-y1
    var d = Math.abs(((x2 - x3) * dy - (y2 - y3) * dx))

    if ( d*d <= 5.0 * tolerance2 * (dx*dx + dy*dy) ) {
      // added factor of 5.0 to match circle resolution      
      subpath.push([x123, y123])
      return                 
    }
    
    // Continue subdivision
    this.addQuadraticBezier(subpath, x1, y1, x12, y12, x123, y123, level + 1, tolerance2)
    this.addQuadraticBezier(subpath, x123, y123, x23, y23, x3, y3, level + 1, tolerance2)
  },
  
  
  addArc : function(subpath, x1, y1, rx, ry, phi, large_arc, sweep, x2, y2, tolerance2) {
    // Implemented based on the SVG implementation notes
    // plus some recursive sugar for incrementally refining the
    // arc resolution until the requested tolerance is met.
    // http://www.w3.org/TR/SVG/implnote.html#ArcImplementationNotes
    var cp = Math.cos(phi);
    var sp = Math.sin(phi);
    var dx = 0.5 * (x1 - x2);
    var dy = 0.5 * (y1 - y2);
    var x_ = cp * dx + sp * dy;
    var y_ = -sp * dx + cp * dy;
    var r2 = (Math.pow(rx*ry,2)-Math.pow(rx*y_,2)-Math.pow(ry*x_,2)) /
             (Math.pow(rx*y_,2)+Math.pow(ry*x_,2));
    if (r2 < 0) { r2 = 0; }
    var r = Math.sqrt(r2);
    if (large_arc == sweep) { r = -r; }
    var cx_ = r*rx*y_ / ry;
    var cy_ = -r*ry*x_ / rx;
    var cx = cp*cx_ - sp*cy_ + 0.5*(x1 + x2);
    var cy = sp*cx_ + cp*cy_ + 0.5*(y1 + y2);
    
    function angle(u, v) {
      var a = Math.acos((u[0]*v[0] + u[1]*v[1]) /
              Math.sqrt((Math.pow(u[0],2) + Math.pow(u[1],2)) *
              (Math.pow(v[0],2) + Math.pow(v[1],2))));
      var sgn = -1;
      if (u[0]*v[1] > u[1]*v[0]) { sgn = 1; }
      return sgn * a;
    }
  
    var psi = angle([1,0], [(x_-cx_)/rx, (y_-cy_)/ry]);
    var delta = angle([(x_-cx_)/rx, (y_-cy_)/ry], [(-x_-cx_)/rx, (-y_-cy_)/ry]);
    if (sweep && delta < 0) { delta += Math.PI * 2; }
    if (!sweep && delta > 0) { delta -= Math.PI * 2; }
    
    function getVertex(pct) {
      var theta = psi + delta * pct;
      var ct = Math.cos(theta);
      var st = Math.sin(theta);
      return [cp*rx*ct-sp*ry*st+cx, sp*rx*ct+cp*ry*st+cy];        
    }
    
    // let the recursive fun begin
    //
    function recursiveArc(parser, t1, t2, c1, c5, level, tolerance2) {
      if (level > 18) {
        // protect from deep recursion cases
        // max 2**18 = 262144 segments
        return
      }
      var tRange = t2-t1
      var tHalf = t1 + 0.5*tRange;
      var c2 = getVertex(t1 + 0.25*tRange);
      var c3 = getVertex(tHalf);
      var c4 = getVertex(t1 + 0.75*tRange);
      if (parser.vertexDistanceSquared(c2, parser.vertexMiddle(c1,c3)) > tolerance2) { 
        recursiveArc(parser, t1, tHalf, c1, c3, level+1, tolerance2);
      }
      subpath.push(c3);
      if (parser.vertexDistanceSquared(c4, parser.vertexMiddle(c3,c5)) > tolerance2) { 
        recursiveArc(parser, tHalf, t2, c3, c5, level+1, tolerance2);
      }
    }
        
    var t1Init = 0.0;
    var t2Init = 1.0;
    var c1Init = getVertex(t1Init);
    var c5Init = getVertex(t2Init);
    subpath.push(c1Init);
    recursiveArc(this, t1Init, t2Init, c1Init, c5Init, 0, tolerance2);
    subpath.push(c5Init);
  },
  

  // handle path data
  //////////////////////////////////////////////////////////////////////////



  

  parseUnit : function(val) {
    if (val == null) {
      return null
    } else {
      var multiplier = 1.0
      if (val.search(/cm$/i) != -1) {
        multiplier = this.dpi/2.54
      } else if (val.search(/mm$/i) != -1) {
        multiplier = this.dpi/25.4
      } else if (val.search(/pt$/i) != -1) {
        multiplier = 1.25
      } else if (val.search(/pc$/i) != -1) {
        multiplier = 15.0
      } else if (val.search(/in$/i) != -1) {
        multiplier = this.dpi
      }
      return multiplier * parseFloat(val.strip())
    }
  },
  
  
  matrixMult : function(mA, mB) {
    return [ mA[0]*mB[0] + mA[2]*mB[1],
             mA[1]*mB[0] + mA[3]*mB[1],
             mA[0]*mB[2] + mA[2]*mB[3],
             mA[1]*mB[2] + mA[3]*mB[3],
             mA[0]*mB[4] + mA[2]*mB[5] + mA[4],
             mA[1]*mB[4] + mA[3]*mB[5] + mA[5] ]
  },
  
  
  matrixApply : function(mat, vec) {
    return [ mat[0]*vec[0] + mat[2]*vec[1] + mat[4],
             mat[1]*vec[0] + mat[3]*vec[1] + mat[5] ] ;
  },  
  matrixApplyWithOutPos : function(mat, vec) {
    return [ mat[0]*vec[0] + mat[2]*vec[1],
             mat[1]*vec[0] + mat[3]*vec[1] ] ;
  },  
  
  matrixGetScale : function(mat) {
    // extract absolute scale from matrix
    var sx = Math.sqrt(mat[0]*mat[0] + mat[1]*mat[1]);
    var sy = Math.sqrt(mat[2]*mat[2] + mat[3]*mat[3]);
    // return dominant axis
    if (sx > sy) {
      return sx;
    } else {
      return sy;
    }
  },
  
  
  vertexDistanceSquared : function(v1, v2) {
    return Math.pow(v2[0]-v1[0], 2) + Math.pow(v2[1]-v1[1], 2);
  },
  
  vertexMiddle : function(v1, v2) {
    return [ (v2[0]+v1[0])/2.0, (v2[1]+v1[1])/2.0 ];
  },

  vertexScale : function(v, f) {
    return [ v[0]*f, v[1]*f ];
  },  

  poly_simplify : function(V, tol2) {
    // V ... [[x1,y1],[x2,y2],...] polyline
    // tol2  ... approximation tolerance squared
    // ============================================== 
    // Copyright 2002, softSurfer (www.softsurfer.com)
    // This code may be freely used and modified for any purpose
    // providing that this copyright notice is included with it.
    // SoftSurfer makes no warranty for this code, and cannot be held
    // liable for any real or imagined damage resulting from its use.
    // Users of this code must verify correctness for their application.
    // http://softsurfer.com/Archive/algorithm_0205/algorithm_0205.htm
    var sum = function(u,v) {return [u[0]+v[0], u[1]+v[1]];}
    var diff = function(u,v) {return [u[0]-v[0], u[1]-v[1]];}
    var prod = function(u,v) {return [u[0]*v[0], u[1]*v[1]];}
    var dot = function(u,v) {return u[0]*v[0] + u[1]*v[1];}
    var norm2 = function(v) {return v[0]*v[0] + v[1]*v[1];}
    var norm = function(v) {return Math.sqrt(norm2(v));}
    var d2 = function(u,v) {return norm2(diff(u,v));}
    var d = function(u,v) {return norm(diff(u,v));}
    
    var simplifyDP = function( tol2, v, j, k, mk ) {
      //  This is the Douglas-Peucker recursive simplification routine
      //  It just marks vertices that are part of the simplified polyline
      //  for approximating the polyline subchain v[j] to v[k].
      //  mk[] ... array of markers matching vertex array v[]
      if (k <= j+1) { // there is nothing to simplify
        return;
      }
      // check for adequate approximation by segment S from v[j] to v[k]
      var maxi = j;          // index of vertex farthest from S
      var maxd2 = 0;         // distance squared of farthest vertex
      S = [v[j], v[k]];  // segment from v[j] to v[k]
      u = diff(S[1], S[0]);   // segment direction vector
      var cu = norm2(u,u);     // segment length squared
      // test each vertex v[i] for max distance from S
      // compute using the Feb 2001 Algorithm's dist_Point_to_Segment()
      // Note: this works in any dimension (2D, 3D, ...)
      var  w;           // vector
      var Pb;                // point, base of perpendicular from v[i] to S
      var b, cw, dv2;        // dv2 = distance v[i] to S squared
      for (var i=j+1; i<k; i++) {
        // compute distance squared
        w = diff(v[i], S[0]);
        cw = dot(w,u);
        if ( cw <= 0 ) {
          dv2 = d2(v[i], S[0]);
        } else if ( cu <= cw ) {
          dv2 = d2(v[i], S[1]);
        } else {
          b = cw / cu;
          Pb = [S[0][0]+b*u[0], S[0][1]+b*u[1]];
          dv2 = d2(v[i], Pb);
        }
        // test with current max distance squared
        if (dv2 <= maxd2) {
          continue;
        }
        // v[i] is a new max vertex
        maxi = i;
        maxd2 = dv2;
      }
      if (maxd2 > tol2) {      // error is worse than the tolerance
        // split the polyline at the farthest vertex from S
        mk[maxi] = 1;      // mark v[maxi] for the simplified polyline
        // recursively simplify the two subpolylines at v[maxi]
        simplifyDP( tol2, v, j, maxi, mk );  // polyline v[j] to v[maxi]
        simplifyDP( tol2, v, maxi, k, mk );  // polyline v[maxi] to v[k]
      }
      // else the approximation is OK, so ignore intermediate vertices
      return;
    }    
    
    var n = V.length;
    var sV = [];    
    var i, k, m, pv;               // misc counters
    vt = [];                       // vertex buffer, points
    mk = [];                       // marker buffer, ints

    // STAGE 1.  Vertex Reduction within tolerance of prior vertex cluster
    vt[0] = V[0];              // start at the beginning
    for (i=k=1, pv=0; i<n; i++) {
      if (d2(V[i], V[pv]) < tol2) {
        continue;
      }
      vt[k++] = V[i];
      pv = i;
    }
    if (pv < n-1) {
      vt[k++] = V[n-1];      // finish at the end
    }

    // STAGE 2.  Douglas-Peucker polyline simplification
    mk[0] = mk[k-1] = 1;       // mark the first and last vertices
    simplifyDP( tol2, vt, 0, k-1, mk );

    // copy marked vertices to the output simplified polyline
    for (i=m=0; i<k; i++) {
      if (mk[i]) {
        sV[m++] = vt[i];
      }
    }
    return sV;
  },
  
}


if (typeof(String.prototype.strip) === "undefined") {
    String.prototype.strip = function() {
        return String(this).replace(/^\s+|\s+$/g, '');
    };
}
