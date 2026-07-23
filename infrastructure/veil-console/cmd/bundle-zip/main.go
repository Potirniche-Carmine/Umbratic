package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: bundle-zip <source-directory> <output.zip>")
		os.Exit(2)
	}
	if err := createZip(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func createZip(source, output string) (returnErr error) {
	source, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	info, err := os.Stat(source)
	if err != nil || !info.IsDir() {
		return errors.New("bundle source must be a directory")
	}
	destination, err := os.OpenFile(output, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		if err := destination.Close(); returnErr == nil {
			returnErr = err
		}
	}()
	archive := zip.NewWriter(destination)
	defer func() {
		if err := archive.Close(); returnErr == nil {
			returnErr = err
		}
	}()

	parent := filepath.Dir(source)
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("bundle must not contain symbolic links")
		}
		name, err := filepath.Rel(parent, path)
		if err != nil {
			return err
		}
		name = filepath.ToSlash(name)
		if entry.IsDir() {
			if path == source {
				return nil
			}
			header := &zip.FileHeader{Name: strings.TrimSuffix(name, "/") + "/", Method: zip.Store}
			header.SetMode(info.Mode())
			header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
			_, err = archive.CreateHeader(header)
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("bundle contains a non-regular file")
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = name
		header.Method = zip.Deflate
		header.SetMode(info.Mode())
		header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
		writer, err := archive.CreateHeader(header)
		if err != nil {
			return err
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, file)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}
