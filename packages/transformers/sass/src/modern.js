// @flow
import type {MutableAsset, ResolveFn, PluginOptions} from '@parcel/types';
import path from 'path';
import {extname} from 'path';
import SourceMap from '@parcel/source-map';
import sass from 'sass';
import {fileURLToPath, pathToFileURL} from 'url';

// E.g: ~library/file.sass
const NODE_MODULE_ALIAS_RE = /^~[^/\\]/;

export async function transformModern(
  asset: MutableAsset,
  config: any,
  resolve: ResolveFn,
  options: PluginOptions,
) {
  let rawConfig = config ?? {};
  let css;
  try {
    let code = await asset.getCode();
    let indentedSyntax =
      rawConfig.syntax === 'indented' ||
      typeof rawConfig.indentedSyntax === 'boolean'
        ? rawConfig.indentedSyntax
        : undefined;
    let result = await sass.compileStringAsync(code, {
      ...rawConfig,
      loadPaths: undefined,
      url: pathToFileURL(asset.filePath),
      importers: [
        ...(rawConfig.importers || []),
        resolvePathImporter({
          asset,
          resolve,
          loadPaths: rawConfig.loadPaths,
          indentedSyntax,
          options,
        }),
      ],
      syntax: (indentedSyntax != null ? indentedSyntax : asset.type === 'sass')
        ? 'indented'
        : 'scss',
      sourceMap: !!asset.env.sourceMap,
    });

    css = result.css;
    for (let included of result.loadedUrls) {
      let file = fileURLToPath(included);
      if (file !== asset.filePath) {
        asset.invalidateOnFileChange(file);
      }
    }

    if (result.sourceMap != null) {
      let map = new SourceMap(options.projectRoot);
      map.addVLQMap(result.sourceMap);
      asset.setMap(map);
    }
  } catch (err) {
    // Adapt the Error object for the reporter.
    err.fileName = err.file;
    err.loc = {
      line: err.line,
      column: err.column,
    };

    throw err;
  }

  asset.type = 'css';
  asset.setCode(css);
}

function resolvePathImporter({
  asset,
  resolve,
  loadPaths,
  indentedSyntax,
  options,
}) {
  return {
    // This is a reimplementation of the Sass resolution algorithm that uses Parcel's
    // FS and tracks all tried files so they are watched for creation.
    async canonicalize(url, {containingUrl}) {
      /*
        Imports are resolved by trying, in order:
          * Loading a file relative to the file in which the `@import` appeared.
          * Each custom importer.
          * Loading a file relative to the current working directory (This rule doesn't really make sense for Parcel).
          * Each load path in `includePaths`
          * Each load path specified in the `SASS_PATH` environment variable, which should be semicolon-separated on Windows and colon-separated elsewhere.

        See: https://sass-lang.com/documentation/js-api#importer
        See also: https://github.com/sass/dart-sass/blob/006e6aa62f2417b5267ad5cdb5ba050226fab511/lib/src/importer/node/implementation.dart
      */

      let containingPath = fileURLToPath(containingUrl);
      let paths = [path.dirname(containingPath)];
      if (loadPaths) {
        paths.push(...loadPaths);
      }

      asset.invalidateOnEnvChange('SASS_PATH');
      if (options.env.SASS_PATH) {
        paths.push(
          ...options.env.SASS_PATH.split(
            process.platform === 'win32' ? ';' : ':',
          ).map(p => path.resolve(options.projectRoot, p)),
        );
      }

      const urls = [url];
      const urlFileName = path.basename(url);
      if (urlFileName[0] !== '_') {
        urls.push(path.join(path.dirname(url), `_${urlFileName}`));
      }

      if (url[0] !== '~') {
        for (let p of paths) {
          for (let u of urls) {
            const filePath = path.resolve(p, u);
            if (await asset.fs.exists(filePath)) {
              return pathToFileURL(filePath);
            }

            asset.invalidateOnFileCreate({filePath});
          }
        }
      }

      // If none of the default sass rules apply, try Parcel's resolver.
      for (let u of urls) {
        if (NODE_MODULE_ALIAS_RE.test(u)) {
          u = u.slice(1);
        }
        try {
          const filePath = await resolve(containingPath, u, {
            packageConditions: ['sass', 'style'],
          });
          return pathToFileURL(filePath);
        } catch (err) {
          continue;
        }
      }
    },
    async load(url) {
      let path = fileURLToPath(url);
      const contents = await asset.fs.readFile(path, 'utf8');
      return {
        contents,
        syntax: (
          indentedSyntax != null ? indentedSyntax : extname(path) === '.sass'
        )
          ? 'indented'
          : 'scss',
      };
    },
  };
}