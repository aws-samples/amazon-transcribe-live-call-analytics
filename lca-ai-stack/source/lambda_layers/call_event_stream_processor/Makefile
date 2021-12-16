# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
# This makefile builds the dependencies for the call_event_stream_processor Lambda
# It is used by sam cli to build the Lambda Layer. See:
# https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/building-layers.html
#
# A makefile build method is needed because the gql library dependency is a
# pre-release python package and the sam build command fails to install it.
# This build method can be eliminated once gql is fully released
MAKEFLAGS += --warn-undefined-variables
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := all
.DELETE_ON_ERROR:
.SUFFIXES:

all: build
.PHONY: all

# this matches the resouce name of the Layer in CloudFormation
RESOURCE_NAME ?= CallEventStreamProcessLayer
SAM_BUILD_DIR ?= ../../../.aws-sam/build

# use this directory for running the Makefile outside of a container build
TARGET_DIR := $(SAM_BUILD_DIR)/$(RESOURCE_NAME)

# sam cli container builds sets ARTIFACTS_DIR - override on non container builds
ARTIFACTS_DIR ?= $(TARGET_DIR)

REQUIREMENTS := requirements.txt
LAYER_DIR := $(ARTIFACTS_DIR)/python
TARGET_REQUIREMENTS := $(LAYER_DIR)/requirements.txt

$(LAYER_DIR):
	mkdir -p "$(@)"

$(TARGET_REQUIREMENTS): $(REQUIREMENTS) | $(LAYER_DIR)
	cp "$(^)" "$(@)"

# sam uses this as the build target
TARGET := build-$(RESOURCE_NAME)

$(TARGET): $(TARGET_REQUIREMENTS) | $(LAYER_DIR)
	python -m pip install -r "$(^)" -t "$(LAYER_DIR)" | \
		tee "$(@)"

build: $(TARGET)
.PHONY: build
